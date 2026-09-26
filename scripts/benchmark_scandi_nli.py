#!/usr/bin/env python3
"""
Benchmark the privacy mode model (alexandrainst/scandi-nli-small) on:
1. data/test.jsonl (565 legal claim pairs)
2. Latency benchmark across sequence lengths.
"""

import json
import time
from pathlib import Path
import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "public" / "models" / "scandi-nli-small-5c7d1ee-q8-v1"
ONNX_PATH = MODEL_DIR / "model.onnx"
TEST_JSONL = ROOT / "data" / "test.jsonl"

def evaluate_test_jsonl():
    print("=" * 60)
    print("1. Evaluating ScandiNLI-small on data/test.jsonl (565 rows)")
    print("=" * 60)

    tokenizer = AutoTokenizer.from_pretrained(str(MODEL_DIR))
    sess_options = ort.SessionOptions()
    sess_options.intra_op_num_threads = 1  # Matches WASM numThreads = 1 in browser
    session = ort.InferenceSession(str(ONNX_PATH), sess_options, providers=["CPUExecutionProvider"])

    id2label = {0: "entailment", 1: "neutral", 2: "contradiction"}

    # Track raw 3-way predictions vs ground truth
    # Ground truth classes: supported, unsupported, incorrect, misleading
    stats = {
        gt: {"total": 0, "pred_entailment": 0, "pred_neutral": 0, "pred_contradiction": 0}
        for gt in ["supported", "unsupported", "incorrect", "misleading"]
    }

    # Also track with the browser decision policy thresholds:
    # supported threshold: 0.97, contradiction threshold: 0.97, neutral threshold: 0.90
    policy_stats = {
        gt: {"total": 0, "correct_label": 0, "wrong_label": 0, "abstain": 0}
        for gt in ["supported", "unsupported", "incorrect", "misleading"]
    }

    total_rows = 0
    with open(TEST_JSONL, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            row = json.loads(line)
            claim = row["claim"]
            sources = row.get("sources") or []
            premise = sources[0]["text"] if sources else ""
            gt = row["label"]

            # Format input as browser worker does: pairInput(tokenizer, passage.text, claim.hypothesis)
            enc = tokenizer(premise, claim, max_length=512, truncation=True, return_tensors="np")
            ort_inputs = {
                "input_ids": enc["input_ids"].astype(np.int64),
                "attention_mask": enc["attention_mask"].astype(np.int64)
            }
            if "token_type_ids" in enc:
                ort_inputs["token_type_ids"] = enc["token_type_ids"].astype(np.int64)

            logits = session.run(None, ort_inputs)[0][0]
            # Softmax
            exp_l = np.exp(logits - np.max(logits))
            probs = exp_l / np.sum(exp_l)
            p_ent, p_neu, p_con = float(probs[0]), float(probs[1]), float(probs[2])

            pred_3way = id2label[int(np.argmax(probs))]
            stats[gt]["total"] += 1
            if pred_3way == "entailment":
                stats[gt]["pred_entailment"] += 1
            elif pred_3way == "neutral":
                stats[gt]["pred_neutral"] += 1
            else:
                stats[gt]["pred_contradiction"] += 1

            # Apply client policy
            policy_stats[gt]["total"] += 1
            decision = "abstain"
            if p_ent >= 0.97:
                decision = "supported"
            elif p_con >= 0.97:
                decision = "contradiction"
            elif p_neu >= 0.90:
                decision = "missing"

            if decision == "abstain":
                policy_stats[gt]["abstain"] += 1
            else:
                # Check if decision is correct or forbidden
                if gt == "supported":
                    if decision == "supported":
                        policy_stats[gt]["correct_label"] += 1
                    else:
                        policy_stats[gt]["wrong_label"] += 1
                elif gt == "unsupported":
                    if decision == "missing":
                        policy_stats[gt]["correct_label"] += 1
                    else:
                        policy_stats[gt]["wrong_label"] += 1
                elif gt == "incorrect":
                    if decision == "contradiction":
                        policy_stats[gt]["correct_label"] += 1
                    else:
                        policy_stats[gt]["wrong_label"] += 1
                elif gt == "misleading":
                    # In client policy, misleading claim receiving 'supported' is forbidden
                    if decision == "supported":
                        policy_stats[gt]["wrong_label"] += 1
                    else:
                        policy_stats[gt]["correct_label"] += 1

            total_rows += 1

    print(f"Total rows evaluated: {total_rows}")
    print("\n--- Raw 3-Way Prediction Distribution ---")
    print(f"{'Ground Truth':14} {'Total':6} {'Pred Entailment':17} {'Pred Neutral':14} {'Pred Contradiction':18}")
    for gt, d in stats.items():
        tot = d["total"]
        pe = f"{d['pred_entailment']} ({d['pred_entailment']/tot*100:.1f}%)"
        pn = f"{d['pred_neutral']} ({d['pred_neutral']/tot*100:.1f}%)"
        pc = f"{d['pred_contradiction']} ({d['pred_contradiction']/tot*100:.1f}%)"
        print(f"{gt:14} {tot:6} {pe:17} {pn:14} {pc:18}")

    print("\n--- Under Client Decision Policy (Thresholds: 0.97 / 0.97 / 0.90) ---")
    print(f"{'Ground Truth':14} {'Total':6} {'Correct':10} {'Wrong':10} {'Abstained':12} {'Abstain %':10}")
    total_abstain = 0
    total_wrong = 0
    total_correct = 0
    for gt, d in policy_stats.items():
        tot = d["total"]
        total_abstain += d["abstain"]
        total_wrong += d["wrong_label"]
        total_correct += d["correct_label"]
        print(f"{gt:14} {tot:6} {d['correct_label']:10} {d['wrong_label']:10} {d['abstain']:12} {d['abstain']/tot*100:.1f}%")

    print(f"\nOverall Abstention Rate: {total_abstain}/{total_rows} ({total_abstain/total_rows*100:.1f}%)")
    print(f"Substantive Decisions: {total_correct + total_wrong}/{total_rows} ({(total_correct+total_wrong)/total_rows*100:.1f}%)")
    if total_correct + total_wrong > 0:
        print(f"Substantive Precision: {total_correct/(total_correct+total_wrong)*100:.1f}%")


def benchmark_latency():
    print("\n" + "=" * 60)
    print("2. Latency Benchmark (Single-thread WASM/CPU environment)")
    print("=" * 60)

    sess_options = ort.SessionOptions()
    sess_options.intra_op_num_threads = 1
    session = ort.InferenceSession(str(ONNX_PATH), sess_options, providers=["CPUExecutionProvider"])

    for length in [64, 128, 256, 384, 512]:
        inputs = {
            "input_ids": np.ones((1, length), dtype=np.int64),
            "attention_mask": np.ones((1, length), dtype=np.int64),
            "token_type_ids": np.zeros((1, length), dtype=np.int64)
        }
        # Warmup
        session.run(None, inputs)

        latencies = []
        for _ in range(15):
            t0 = time.perf_counter()
            session.run(None, inputs)
            latencies.append((time.perf_counter() - t0) * 1000)

        print(f"Context length {length:3d} tokens: mean = {np.mean(latencies):5.1f} ms | min = {np.min(latencies):5.1f} ms | p95 = {np.percentile(latencies, 95):5.1f} ms")


if __name__ == "__main__":
    evaluate_test_jsonl()
    benchmark_latency()
