#!/usr/bin/env python3
"""Evaluate an exported three-way browser model on the partitions and fixtures.

The model is read from public/models/<version>/model.onnx, the file the browser
loads. The premise is one BM25 window of 350 tokens, as src/semantic-input.js
builds it for weights whose manifest says "premise": "window". Labels follow the
browser policy: the manifest's calibrated thresholds when --calibrate has
written them, otherwise entailment or contradiction at 0.97 or more and neutral
at 0.90 or more; below the threshold the label is abstain.

Run: python scripts/evaluate_browser_model.py --version scandi-nli-small-legal-v2-q8
"""

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.windowing import window_premise  # noqa: E402

LABELS = ["entailment", "neutral", "contradiction"]
FOUR_TO_THREE = {"supported": "entailment", "unsupported": "neutral", "incorrect": "contradiction", "misleading": "neutral"}
THRESHOLDS = {"entailment": 0.97, "neutral": 0.90, "contradiction": 0.97}
SWEDISH = {"entailment": "Stöd hittat", "neutral": "Stöd saknas", "contradiction": "Möjlig motsägelse"}


class BrowserModel:
    def __init__(self, model_dir: Path, threads: int = 4):
        self.tokenizer = AutoTokenizer.from_pretrained(str(model_dir))
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        self.session = ort.InferenceSession(str(model_dir / "model.onnx"), options, providers=["CPUExecutionProvider"])

    def probs(self, claim: str, sources: list[dict]) -> np.ndarray | None:
        premise = window_premise(claim, sources, max_premise_tokens=350, tokenizer=self.tokenizer)
        enc = self.tokenizer(premise, claim, return_tensors="np", truncation=True, max_length=512)
        if enc["input_ids"].shape[1] > 512:
            return None
        inputs = {k: v.astype(np.int64) for k, v in enc.items() if k in ("input_ids", "attention_mask", "token_type_ids")}
        logits = self.session.run(None, inputs)[0][0]
        exp = np.exp(logits - logits.max())
        return exp / exp.sum()


def decide(probs: np.ndarray) -> tuple[str, str | None]:
    label = LABELS[int(probs.argmax())]
    return label, (label if probs.max() >= THRESHOLDS[label] else None)


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def fixture_source_text(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    if path.name.startswith(("nja", "hfd")):
        match = re.search(r"##\s+(?:Högsta\s+domstolen|Högsta\s+förvaltningsdomstolen)", text)
        return (text[match.start():] if match else text).strip()
    return text.strip()


def run_examples(model: BrowserModel, examples: list[dict], name: str) -> dict:
    accepted = wrong = argmax_correct = assessed = 0
    results = []
    for example in examples:
        probs = model.probs(example["claim"], [example["source"]])
        if probs is None:
            continue
        argmax, label = decide(probs)
        allowed = example["allowed"]
        results.append({"id": example["id"], "expected": sorted(allowed), "argmax": argmax, "label": label,
                        "probs": {l: round(float(p), 4) for l, p in zip(LABELS, probs)}})
        assessed += 1
        argmax_correct += argmax in allowed
        if label:
            accepted += 1
            wrong += label not in allowed
        mark = "WRONG" if label and label not in allowed else ""
        print(f"  {example['id']:<45} exp={'/'.join(sorted(allowed)):<24} argmax={argmax:<13} p={probs.max():.3f} {SWEDISH[label] if label else 'abstain':<18} {mark}")
    print(f"{name}: argmax in allowed {argmax_correct}/{assessed}; accepted {accepted}, wrong accepted {wrong}")
    return {"assessed": assessed, "argmax_correct": argmax_correct, "accepted": accepted, "wrong_accepted": wrong, "results": results}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default="scandi-nli-small-legal-v2-q8")
    parser.add_argument("--test-data", default="data/test.jsonl")
    parser.add_argument("--report", default=None, help="Write a JSON report here.")
    parser.add_argument("--calibrate", action="store_true",
                        help="Select fail-closed thresholds on data/calibration.jsonl and write them into the manifest.")
    parser.add_argument("--cal-data", default="data/calibration.jsonl")
    args = parser.parse_args()
    model_dir = Path("public/models") / args.version
    model = BrowserModel(model_dir)

    if args.calibrate:
        from backend.calibration import select_fail_closed_thresholds
        probs, targets = [], []
        for row in read_jsonl(Path(args.cal_data)):
            p = model.probs(row["claim"], row["sources"])
            if p is not None:
                probs.append(p)
                targets.append(LABELS.index(FOUR_TO_THREE[row["label"]]))
        selection = select_fail_closed_thresholds(
            np.array(probs), np.array(targets), LABELS,
            {"entailment": 0.95, "neutral": 0.90, "contradiction": 0.95}, minimum_accepted=30, wilson_slack=0.05)
        manifest_path = model_dir / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["thresholds"] = {
            "supported": round(selection["thresholds"]["entailment"], 4),
            "neutral": round(selection["thresholds"]["neutral"], 4),
            "contradiction": round(selection["thresholds"]["contradiction"], 4),
            "calibration_rows": len(targets),
            "policy": "fail-closed, targets 0.95/0.90/0.95, Wilson slack 0.05, minimum 30 accepted; 1.01 disables a label",
        }
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        THRESHOLDS.update({"entailment": manifest["thresholds"]["supported"], "neutral": manifest["thresholds"]["neutral"],
                           "contradiction": manifest["thresholds"]["contradiction"]})
        print("Calibrated thresholds written to manifest:", manifest["thresholds"])
        for name, metrics in selection["class_metrics"].items():
            print(f"  {name:<13} {'enabled' if metrics['enabled'] else 'DISABLED (' + metrics['failure_reason'] + ')'}; accepted={metrics['accepted']}, precision={metrics['empirical_precision']}")

    print("Test partition (three-way):")
    confusion = Counter()
    accepted = wrong = 0
    rows = read_jsonl(Path(args.test_data))
    scored = 0
    for row in rows:
        probs = model.probs(row["claim"], row["sources"])
        if probs is None:
            continue
        scored += 1
        expected = FOUR_TO_THREE[row["label"]]
        argmax, label = decide(probs)
        confusion[(expected, argmax)] += 1
        if label:
            accepted += 1
            wrong += label != expected
    correct = sum(v for (e, a), v in confusion.items() if e == a)
    print(f"  rows {scored}, argmax accuracy {correct / scored:.3f}, accepted {accepted}, precision on accepted {(accepted - wrong) / accepted if accepted else float('nan'):.3f}")
    for expected in LABELS:
        row_counts = [confusion[(expected, a)] for a in LABELS]
        print(f"  {expected:<13} {row_counts}")

    print("Source-grounding fixture:")
    grounding = json.loads(Path("test/fixtures/source-grounding.json").read_text(encoding="utf-8"))
    examples = []
    for example in grounding["examples"]:
        source = grounding["sources"][example["source_id"]]
        expected = example["expected"]["3way"]
        examples.append({"id": example["id"], "claim": example["claim"], "allowed": {FOUR_TO_THREE.get(expected, expected)},
                         "source": {"citation": source["citation"], "text": source["text"], "unit_type": "statute_provision"}})
    grounding_report = run_examples(model, examples, "source-grounding")

    print("Legal-claims fixture:")
    kind_allowed = {"correct": {"entailment"}, "missing": {"neutral"}, "incorrect": {"contradiction", "neutral"}, "misleading": {"neutral", "contradiction"}}
    examples = []
    for claim in json.loads(Path("test/fixtures/legal-claims.json").read_text(encoding="utf-8")):
        if claim["kind"] not in kind_allowed:
            continue
        examples.append({"id": claim["id"], "claim": claim["text"], "allowed": kind_allowed[claim["kind"]],
                         "source": {"citation": claim["citation"], "text": fixture_source_text(Path("test/fixtures/legal-sources") / claim["file"]),
                                    "unit_type": "case_judgment" if claim["file"].startswith(("nja", "hfd")) else "statute_provision"}})
    fixture_report = run_examples(model, examples, "legal-claims")

    if args.report:
        Path(args.report).write_text(json.dumps({
            "version": args.version, "test_rows": scored, "test_argmax_accuracy": correct / scored,
            "test_accepted": accepted, "test_wrong_accepted": wrong,
            "confusion": {f"{e}->{a}": v for (e, a), v in confusion.items()},
            "source_grounding": grounding_report, "legal_claims": fixture_report,
        }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
