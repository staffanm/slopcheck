#!/usr/bin/env python3
"""
Evaluation, calibration and abstention pipeline for the 4-way source-grounded claim classifier.
Performs:
1. Full test partition evaluation with breakdowns by length bucket and source type.
2. Temperature scaling on the calibration partition to minimize NLL and ECE.
3. Threshold and margin selection on calibration partition for target precisions.
4. Source-grounding test suite verification (fictitious supported, contrary incorrect, unrelated unsupported).
5. Independent 70-claim fixture evaluation under Section 3 cited unit rules.
Outputs:
- models/classifier-mmbert-small-4way/calibration.json
- models/classifier-mmbert-small-4way/evaluation_report.json
"""

import argparse
import json
import math
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import scipy.optimize
import torch
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from backend.resolver import format_premise
from backend.semantic import check_assessable
from backend.windowing import window_premise

def get_premise(row: dict, tokenizer: Any = None) -> str:
    sources = row.get("sources") or ([row["source"]] if "source" in row else [])
    return window_premise(row["claim"], sources, max_premise_tokens=380, tokenizer=tokenizer)

LABEL2ID = {
    "supported": 0,
    "unsupported": 1,
    "incorrect": 2,
    "misleading": 3
}
ID2LABEL = {v: k for k, v in LABEL2ID.items()}
CLASSES = ["supported", "unsupported", "incorrect", "misleading"]

SOURCE_GROUNDING_CASES = [
    {
        "id": "sg-1-unrelated-source",
        "name": "true legal proposition + unrelated source -> unsupported",
        "claim": "Ett anbud är bindande för anbudsgivaren under acceptfristen.",
        "source_text": "Om rättegångskostnader i hovrätt gäller 18 kap. rättegångsbalken om inte annat är föreskrivet.",
        "expected": "unsupported",
        "rationale": "Claim is true in Swedish law (1 § avtalslagen), but supplied source is 18 kap RB, which says nothing about anbud."
    },
    {
        "id": "sg-2-opposite-source",
        "name": "true legal proposition + source stating the opposite -> incorrect",
        "claim": "Den som uppsåtligen berövar annan livet döms för mord till fängelse.",
        "source_text": "Den som uppsåtligen berövar annan livet ska inte dömas för mord och är fri från straffrättsligt ansvar.",
        "expected": "incorrect",
        "rationale": "Claim is true under 3:1 BrB, but supplied source explicitly states the contrary."
    },
    {
        "id": "sg-3-fictitious-stated",
        "name": "fictitious proposition + source stating it -> supported",
        "claim": "Rymdfarkoster som framförs på allmän väg måste ha dubbla backspeglar av titan.",
        "source_text": "Enligt 12 § rymdtrafikförordningen måste rymdfarkoster som framförs på allmän väg ha dubbla backspeglar av titan.",
        "expected": "supported",
        "rationale": "Proposition is fictitious in real law, but the supplied source clearly states it."
    },
    {
        "id": "sg-4-wrong-paragraph",
        "name": "true proposition + correct judgment, wrong paragraph -> unsupported",
        "claim": "Det föreligger ett krav på uppsåt vid grovt skattebrott enligt 2 § skattebrottslagen.",
        "source_text": "Högsta domstolen finner att hovrättens domslut beträffande utvisning ska fastställas.",
        "expected": "unsupported",
        "rationale": "Correct judgment context, but the specific paragraph only discusses deportation."
    }
]


def load_jsonl(path: Path | str) -> List[dict]:
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def get_token_length_bucket(token_length: int) -> str:
    if token_length <= 512:
        return "<=512"
    elif token_length <= 2048:
        return "513-2048"
    elif token_length <= 4096:
        return "2049-4096"
    else:
        return "4097-8192"


def compute_metrics(preds: List[int], targets: List[int]) -> dict:
    total = len(targets)
    if total == 0:
        return {"accuracy": 0.0, "macro_f1": 0.0, "per_class": {}, "confusion_matrix": []}

    correct = sum(p == t for p, t in zip(preds, targets))
    accuracy = correct / total

    cm = [[0 for _ in range(4)] for _ in range(4)]
    for p, t in zip(preds, targets):
        cm[t][p] += 1

    per_class = {}
    f1s = []
    for c in range(4):
        tp = cm[c][c]
        fp = sum(cm[r][c] for r in range(4) if r != c)
        fn = sum(cm[c][col] for col in range(4) if col != c)
        prec = tp / max(tp + fp, 1)
        rec = tp / max(tp + fn, 1)
        f1 = 2 * prec * rec / max(prec + rec, 1e-8)
        per_class[ID2LABEL[c]] = {
            "precision": prec,
            "recall": rec,
            "f1": f1,
            "support": sum(cm[c])
        }
        f1s.append(f1)

    macro_f1 = sum(f1s) / len(f1s)
    return {
        "accuracy": accuracy,
        "macro_f1": macro_f1,
        "per_class": per_class,
        "confusion_matrix": cm
    }


def compute_ece(probs: np.ndarray, targets: np.ndarray, n_bins: int = 10) -> float:
    """Computes Expected Calibration Error."""
    bin_boundaries = np.linspace(0, 1, n_bins + 1)
    confidences = np.max(probs, axis=1)
    predictions = np.argmax(probs, axis=1)
    accuracies = (predictions == targets).astype(float)

    ece = 0.0
    for i in range(n_bins):
        bin_lower = bin_boundaries[i]
        bin_upper = bin_boundaries[i + 1]
        in_bin = (confidences > bin_lower) & (confidences <= bin_upper)
        prop_in_bin = np.mean(in_bin.astype(float))
        if prop_in_bin > 0:
            accuracy_in_bin = np.mean(accuracies[in_bin])
            avg_confidence_in_bin = np.mean(confidences[in_bin])
            ece += np.abs(avg_confidence_in_bin - accuracy_in_bin) * prop_in_bin
    return float(ece)


def compute_brier_score(probs: np.ndarray, targets: np.ndarray) -> float:
    """Computes multi-class Brier score."""
    n_classes = probs.shape[1]
    one_hot = np.eye(n_classes)[targets]
    return float(np.mean(np.sum((probs - one_hot) ** 2, axis=1)))


def extract_deciding_court_from_fixture_markdown(markdown_text: str) -> str:
    """
    Extracts deciding court's domskal and domslut from fixture markdown files
    (excluding lower court sections like Tingsrätt, Hovrätt and excluding headnotes).
    """
    # Look for Högsta domstolen or Högsta förvaltningsdomstolen header
    hd_match = re.search(r"##\s+(?:Högsta\s+domstolen|Högsta\s+förvaltningsdomstolen|Regeringsrätten)", markdown_text, re.IGNORECASE)
    if hd_match:
        # Court text starts from this heading
        sub = markdown_text[hd_match.start():]
        # Exclude dissenting opinions or betänkande if at the very end
        return sub.strip()
    return markdown_text.strip()


class EvaluatorAndCalibrator:
    def __init__(self, model_dir: Path | str, device: Optional[str] = None):
        self.model_dir = Path(model_dir)
        self.device = torch.device(device if device else ("cuda" if torch.cuda.is_available() else "cpu"))
        print(f"Loading model and tokenizer from {self.model_dir} on {self.device}...")
        self.tokenizer = AutoTokenizer.from_pretrained(self.model_dir)
        self.model = AutoModelForSequenceClassification.from_pretrained(self.model_dir)
        self.model.to(self.device)
        self.model.eval()

    def predict_logits(self, pairs: List[Tuple[str, str]], batch_size: int = 4) -> np.ndarray:
        """Computes raw logits for a list of (premise, hypothesis) pairs."""
        all_logits = []
        for i in range(0, len(pairs), batch_size):
            chunk = pairs[i:i + batch_size]
            premises = [c[0] for c in chunk]
            hypotheses = [c[1] for c in chunk]

            encodings = self.tokenizer(
                premises,
                hypotheses,
                padding=True,
                truncation=True,
                max_length=512,
                return_tensors="pt"
            )
            input_ids = encodings["input_ids"].to(self.device)
            attention_mask = encodings["attention_mask"].to(self.device)
            token_type_ids = encodings.get("token_type_ids")
            if token_type_ids is not None:
                token_type_ids = token_type_ids.to(self.device)

            with torch.no_grad():
                with torch.amp.autocast(device_type=self.device.type, dtype=torch.bfloat16 if self.device.type == "cuda" else torch.float32):
                    outputs = self.model(input_ids=input_ids, attention_mask=attention_mask, token_type_ids=token_type_ids)
                    logits = outputs.logits.float().cpu().numpy()
            all_logits.append(logits)

        return np.concatenate(all_logits, axis=0)

    def fit_temperature(self, calibration_logits: np.ndarray, targets: np.ndarray) -> float:
        """Finds optimal temperature T > 0 using scipy minimize_scalar."""
        def nll_obj(t: float) -> float:
            scaled = calibration_logits / max(t, 1e-4)
            # Log-sum-exp
            max_s = np.max(scaled, axis=1, keepdims=True)
            log_sum_exp = max_s.squeeze(1) + np.log(np.sum(np.exp(scaled - max_s), axis=1))
            true_logits = scaled[np.arange(len(targets)), targets]
            loss = np.mean(log_sum_exp - true_logits)
            return float(loss)

        res = scipy.optimize.minimize_scalar(nll_obj, bounds=(0.1, 10.0), method="bounded")
        opt_t = float(res.x)
        print(f"Optimal Temperature scaling parameter T: {opt_t:.4f} (NLL: {res.fun:.4f})")
        return opt_t

    def select_thresholds(
        self,
        cal_probs: np.ndarray,
        cal_targets: np.ndarray,
        target_precisions: Dict[str, float]
    ) -> Tuple[Dict[str, float], float]:
        """
        Derives per-class thresholds and minimum margin from the calibration partition
        by maximizing coverage subject to target precision per accepted class.
        """
        p1 = np.max(cal_probs, axis=1)
        preds = np.argmax(cal_probs, axis=1)
        # Sort probabilities to get p1 and p2
        sorted_probs = np.sort(cal_probs, axis=1)
        p2 = sorted_probs[:, -2]
        margins = p1 - p2

        best_margin = 0.05
        best_thresholds = {"supported": 0.50, "unsupported": 0.50, "incorrect": 0.50, "misleading": 0.50}
        best_coverage = 0.0

        margin_grid = [0.0, 0.05, 0.10, 0.15, 0.20]
        threshold_grid = np.linspace(0.40, 0.85, 10)

        # Optimize per class independently then find suitable margin
        class_thresholds = {}
        for c_idx, c_name in enumerate(CLASSES):
            tgt_prec = target_precisions.get(c_name, 0.90)
            c_mask = (preds == c_idx)
            if not np.any(c_mask):
                class_thresholds[c_name] = 0.50
                continue

            c_targets = (cal_targets[c_mask] == c_idx)
            c_p1 = p1[c_mask]

            found_thresh = 0.50
            found_prec = 0.0
            found_cov = 0.0

            for th in threshold_grid:
                accepted = c_p1 >= th
                if np.sum(accepted) == 0:
                    continue
                prec = np.mean(c_targets[accepted].astype(float))
                cov = np.sum(accepted) / len(c_p1)
                if prec >= tgt_prec:
                    found_thresh = th
                    found_prec = prec
                    found_cov = cov
                    break
                elif prec > found_prec:
                    found_thresh = th
                    found_prec = prec
                    found_cov = cov

            class_thresholds[c_name] = round(float(found_thresh), 3)

        # Now select minimum margin that optimizes overall accepted precision and coverage
        for m in margin_grid:
            accepted_mask = np.zeros(len(cal_probs), dtype=bool)
            for i in range(len(cal_probs)):
                cls = ID2LABEL[preds[i]]
                if p1[i] >= class_thresholds[cls] and margins[i] >= m:
                    accepted_mask[i] = True

            cov = np.mean(accepted_mask.astype(float))
            if cov > 0:
                acc_preds = preds[accepted_mask]
                acc_targets = cal_targets[accepted_mask]
                acc = np.mean(acc_preds == acc_targets)
                if cov > best_coverage and acc >= 0.85:
                    best_coverage = cov
                    best_margin = m

        return class_thresholds, best_margin


def main():
    parser = argparse.ArgumentParser(description="Evaluate and calibrate 4-way claim classifier.")
    parser.add_argument("--model-dir", type=str, default="models/classifier-mmbert-small-4way")
    parser.add_argument("--test-data", type=str, default="data/test.jsonl")
    parser.add_argument("--cal-data", type=str, default="data/calibration.jsonl")
    parser.add_argument("--fixtures-claims", type=str, default="test/fixtures/legal-claims.json")
    parser.add_argument("--fixtures-sources", type=str, default="test/fixtures/legal-sources")
    args = parser.parse_args()

    model_dir = Path(args.model_dir)
    evaluator = EvaluatorAndCalibrator(model_dir)

    print("\n=======================================================")
    print(" 1. CALIBRATION & THRESHOLD TUNING (data/calibration.jsonl)")
    print("=======================================================")
    cal_rows = load_jsonl(args.cal_data)
    print(f"Loaded {len(cal_rows)} calibration rows.")
    cal_pairs = [(get_premise(r, evaluator.tokenizer), r["claim"]) for r in cal_rows]
    cal_targets = np.array([LABEL2ID[r["label"]] for r in cal_rows])

    raw_cal_logits = evaluator.predict_logits(cal_pairs)
    raw_cal_probs = np.exp(raw_cal_logits - np.max(raw_cal_logits, axis=1, keepdims=True))
    raw_cal_probs /= np.sum(raw_cal_probs, axis=1, keepdims=True)

    ece_before = compute_ece(raw_cal_probs, cal_targets)
    brier_before = compute_brier_score(raw_cal_probs, cal_targets)
    print(f"Before calibration: ECE = {ece_before:.4f}, Brier Score = {brier_before:.4f}")

    opt_temp = evaluator.fit_temperature(raw_cal_logits, cal_targets)
    cal_scaled_logits = raw_cal_logits / opt_temp
    cal_probs = np.exp(cal_scaled_logits - np.max(cal_scaled_logits, axis=1, keepdims=True))
    cal_probs /= np.sum(cal_probs, axis=1, keepdims=True)

    ece_after = compute_ece(cal_probs, cal_targets)
    brier_after = compute_brier_score(cal_probs, cal_targets)
    print(f"After calibration:  ECE = {ece_after:.4f}, Brier Score = {brier_after:.4f}")

    target_precisions = {
        "supported": 0.95,
        "incorrect": 0.95,
        "unsupported": 0.90,
        "misleading": 0.90
    }
    thresholds, min_margin = evaluator.select_thresholds(cal_probs, cal_targets, target_precisions)
    print(f"Selected Thresholds: {thresholds}")
    print(f"Selected Minimum Margin: {min_margin:.2f}")

    calibration_config = {
        "temperature": round(opt_temp, 4),
        "minimum_margin": round(min_margin, 4),
        "thresholds": thresholds,
        "ece_before": round(ece_before, 4),
        "ece_after": round(ece_after, 4),
        "brier_before": round(brier_before, 4),
        "brier_after": round(brier_after, 4),
        "target_precisions": target_precisions
    }
    with open(model_dir / "calibration.json", "w", encoding="utf-8") as f:
        json.dump(calibration_config, f, indent=2, ensure_ascii=False)
    print(f"Saved calibration config to {model_dir / 'calibration.json'}")

    print("\n=======================================================")
    print(" 2. TEST PARTITION EVALUATION (data/test.jsonl)")
    print("=======================================================")
    test_rows = load_jsonl(args.test_data)
    print(f"Loaded {len(test_rows)} test rows.")
    test_pairs = [(get_premise(r, evaluator.tokenizer), r["claim"]) for r in test_rows]
    test_targets = [LABEL2ID[r["label"]] for r in test_rows]

    raw_test_logits = evaluator.predict_logits(test_pairs)
    test_scaled_logits = raw_test_logits / opt_temp
    test_probs = np.exp(test_scaled_logits - np.max(test_scaled_logits, axis=1, keepdims=True))
    test_probs /= np.sum(test_probs, axis=1, keepdims=True)
    test_preds = np.argmax(test_probs, axis=1).tolist()

    overall_metrics = compute_metrics(test_preds, test_targets)
    print(f"Test Accuracy: {overall_metrics['accuracy']*100:.2f}% | Macro F1: {overall_metrics['macro_f1']*100:.2f}%")
    print("Per-class performance:")
    for lbl, res in overall_metrics["per_class"].items():
        print(f"  {lbl.upper():<12} P: {res['precision']*100:.1f}% | R: {res['recall']*100:.1f}% | F1: {res['f1']*100:.1f}% (N={res['support']})")

    # Breakdown by length bucket
    print("\n--- Breakdown by Token Length Bucket ---")
    length_buckets = ["<=512", "513-2048", "2049-4096", "4097-8192"]
    bucket_results = {}
    for b in length_buckets:
        indices = [i for i, r in enumerate(test_rows) if get_token_length_bucket(r.get("token_length", 0)) == b]
        if indices:
            b_preds = [test_preds[i] for i in indices]
            b_targets = [test_targets[i] for i in indices]
            b_metrics = compute_metrics(b_preds, b_targets)
            bucket_results[b] = {
                "count": len(indices),
                "accuracy": b_metrics["accuracy"],
                "macro_f1": b_metrics["macro_f1"]
            }
            print(f"  Bucket {b:<10}: N={len(indices):<3} | Acc: {b_metrics['accuracy']*100:.1f}% | Macro F1: {b_metrics['macro_f1']*100:.1f}%")
        else:
            print(f"  Bucket {b:<10}: N=0")

    # Breakdown by source unit type
    print("\n--- Breakdown by Source Unit Type ---")
    def get_row_unit_type(r):
        sources = r.get("sources") or ([r["source"]] if "source" in r else [])
        return sources[0].get("unit_type", "unknown") if sources else "unknown"

    unit_types = sorted(list(set(get_row_unit_type(r) for r in test_rows)))
    type_results = {}
    for ut in unit_types:
        indices = [i for i, r in enumerate(test_rows) if get_row_unit_type(r) == ut]
        if indices:
            u_preds = [test_preds[i] for i in indices]
            u_targets = [test_targets[i] for i in indices]
            u_metrics = compute_metrics(u_preds, u_targets)
            type_results[ut] = {
                "count": len(indices),
                "accuracy": u_metrics["accuracy"],
                "macro_f1": u_metrics["macro_f1"]
            }
            print(f"  Type {ut:<15}: N={len(indices):<3} | Acc: {u_metrics['accuracy']*100:.1f}% | Macro F1: {u_metrics['macro_f1']*100:.1f}%")

    print("\n=======================================================")
    print(" 3. SOURCE-GROUNDING SET VERIFICATION")
    print("=======================================================")
    sg_pairs = [(c["source_text"], c["claim"]) for c in SOURCE_GROUNDING_CASES]
    sg_logits = evaluator.predict_logits(sg_pairs) / opt_temp
    sg_probs = np.exp(sg_logits - np.max(sg_logits, axis=1, keepdims=True))
    sg_probs /= np.sum(sg_probs, axis=1, keepdims=True)
    sg_preds = [ID2LABEL[p] for p in np.argmax(sg_probs, axis=1)]

    sg_results = []
    sg_all_passed = True
    for idx, c in enumerate(SOURCE_GROUNDING_CASES):
        pred = sg_preds[idx]
        expected = c["expected"]
        prob = sg_probs[idx][LABEL2ID[pred]]
        passed = (pred == expected)
        if not passed:
            sg_all_passed = False
        status_str = "PASS" if passed else "FAIL"
        print(f"[{status_str}] {c['name']}")
        print(f"       Expected: {expected} | Predicted: {pred} ({prob*100:.1f}%)")
        sg_results.append({
            "id": c["id"],
            "name": c["name"],
            "expected": expected,
            "predicted": pred,
            "probability": float(prob),
            "passed": passed
        })

    print(f"\nSource-grounding verification: {'ALL PASSED' if sg_all_passed else 'SOME FAILED'}")

    print("\n=======================================================")
    print(" 4. INDEPENDENT 70-CLAIM FIXTURE EVALUATION")
    print("=======================================================")
    with open(args.fixtures_claims, "r", encoding="utf-8") as f:
        fixtures = json.load(f)
    print(f"Loaded {len(fixtures)} fixture claims.")

    fixtures_sources_dir = Path(args.fixtures_sources)
    harness_accepted = 0
    harness_abstain = 0
    harness_correct = 0
    abstain_reasons = {}

    fixture_eval_rows = []
    for item in fixtures:
        claim_text = item["text"]
        kind = item["kind"]

        # Step A: Structural harness check
        assessable, reason = check_assessable(claim_text)
        if not assessable:
            harness_abstain += 1
            abstain_reasons[f"unassessable_{reason}"] = abstain_reasons.get(f"unassessable_{reason}", 0) + 1
            fixture_eval_rows.append({
                "id": item["id"],
                "kind": kind,
                "status": "nonsensical",
                "pred": "nonsensical",
                "abstain_reason": reason,
                "correct": (kind == "nonsensical")
            })
            continue

        # Step B: Source resolution under Section 3
        source_file = fixtures_sources_dir / item["file"]
        if not source_file.exists():
            harness_abstain += 1
            abstain_reasons["missing_source_file"] = abstain_reasons.get("missing_source_file", 0) + 1
            continue

        with open(source_file, "r", encoding="utf-8") as sf:
            source_content = sf.read()

        # Isolate deciding court if judgment
        source_unit_text = extract_deciding_court_from_fixture_markdown(source_content)
        # BM25 paragraph windowing
        windowed_source_text = window_premise(
            claim_text,
            [{"citation": item.get("file", ""), "text": source_unit_text}],
            max_premise_tokens=380,
            tokenizer=evaluator.tokenizer
        )

        # Step C: Model inference
        pair_enc = evaluator.tokenizer(windowed_source_text, claim_text, truncation=False)
        t_len = len(pair_enc["input_ids"])
        if t_len > 512:
            harness_abstain += 1
            abstain_reasons["unit_too_long"] = abstain_reasons.get("unit_too_long", 0) + 1
            fixture_eval_rows.append({
                "id": item["id"],
                "kind": kind,
                "status": "abstain",
                "pred": "abstain",
                "abstain_reason": "unit_too_long",
                "correct": False
            })
            continue

        # Inference
        logits = evaluator.predict_logits([(windowed_source_text, claim_text)])[0] / opt_temp
        probs = np.exp(logits - np.max(logits))
        probs /= np.sum(probs)

        pred_idx = int(np.argmax(probs))
        pred_label = ID2LABEL[pred_idx]
        p1 = float(probs[pred_idx])
        sorted_p = np.sort(probs)
        margin = float(sorted_p[-1] - sorted_p[-2])

        # Abstention check
        th = thresholds.get(pred_label, 0.5)
        if p1 < th or margin < min_margin:
            harness_abstain += 1
            r_code = "low_confidence" if p1 < th else "low_margin"
            abstain_reasons[r_code] = abstain_reasons.get(r_code, 0) + 1
            fixture_eval_rows.append({
                "id": item["id"],
                "kind": kind,
                "status": "abstain",
                "pred": pred_label,
                "p1": p1,
                "margin": margin,
                "abstain_reason": r_code,
                "correct": False
            })
            continue

        # Accepted prediction
        harness_accepted += 1
        # Map label to fixture kind
        mapped_kind = "correct" if pred_label == "supported" else ("missing" if pred_label == "unsupported" else pred_label)
        is_match = (mapped_kind == kind)
        if is_match:
            harness_correct += 1

        fixture_eval_rows.append({
            "id": item["id"],
            "kind": kind,
            "status": "accepted",
            "pred": pred_label,
            "mapped_pred": mapped_kind,
            "p1": p1,
            "margin": margin,
            "correct": is_match
        })

    coverage = harness_accepted / len(fixtures)
    accepted_precision = harness_correct / max(harness_accepted, 1)
    print(f"\nFixture Results (Total N={len(fixtures)}):")
    print(f"  Accepted Predictions: {harness_accepted} ({coverage*100:.1f}% coverage)")
    print(f"  Abstained / Filtered: {harness_abstain}")
    print(f"  Precision among Accepted: {accepted_precision*100:.1f}% ({harness_correct}/{harness_accepted})")
    print("Abstain reasons breakdown:")
    for reason, cnt in abstain_reasons.items():
        print(f"  {reason:<25}: {cnt}")

    # Save full evaluation report
    report = {
        "overall_test_metrics": overall_metrics,
        "token_length_breakdown": bucket_results,
        "source_type_breakdown": type_results,
        "calibration": calibration_config,
        "source_grounding_suite": sg_results,
        "fixtures_summary": {
            "total": len(fixtures),
            "accepted": harness_accepted,
            "coverage": coverage,
            "precision_on_accepted": accepted_precision,
            "abstain_count": harness_abstain,
            "abstain_reasons": abstain_reasons
        }
    }
    with open(model_dir / "evaluation_report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"\nFull evaluation report saved to {model_dir / 'evaluation_report.json'}")


if __name__ == "__main__":
    main()
