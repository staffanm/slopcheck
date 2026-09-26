#!/usr/bin/env python3
"""Calibrate and evaluate the served INT8 ONNX classifier.

Everything here runs through backend.model.ClaimClassifier, the code path the
API uses: same windowing, same headers, same tokenizer, same quantized weights.
The earlier calibration was fitted on fp32 torch logits and applied to INT8
logits; this script removes that gap.

Steps:
  1. raw logits for data/calibration.jsonl -> temperature (NLL), fail-closed
     per-class thresholds and margin (backend.calibration)
  2. writes <model-dir>/calibration.json, which the server loads at start
  3. data/test.jsonl: argmax metrics and the selective policy, by unit type
     and by family origin
  4. test/fixtures/source-grounding.json and test/fixtures/legal-claims.json:
     argmax and accepted-label results, never used for selection
  5. writes <model-dir>/evaluation_report.json

Run: python scripts/calibrate_onnx.py --model-dir models/classifier-kb-bert-4way
"""

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import scipy.optimize

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.calibration import select_fail_closed_thresholds, selective_metrics  # noqa: E402
from backend.model import ID2LABEL, ClaimClassifier  # noqa: E402
from backend.semantic import check_assessable  # noqa: E402

CLASSES = [ID2LABEL[i] for i in range(4)]
FIXTURE_KIND = {"correct": "supported", "missing": "unsupported", "incorrect": "incorrect", "misleading": "misleading"}


def softmax(logits: np.ndarray, temperature: float) -> np.ndarray:
    scaled = logits / temperature
    scaled = scaled - scaled.max(axis=1, keepdims=True)
    exp = np.exp(scaled)
    return exp / exp.sum(axis=1, keepdims=True)


def fit_temperature(logits: np.ndarray, targets: np.ndarray) -> float:
    def nll(t: float) -> float:
        probs = softmax(logits, t)
        return float(-np.mean(np.log(probs[np.arange(len(targets)), targets] + 1e-12)))
    result = scipy.optimize.minimize_scalar(nll, bounds=(0.1, 10.0), method="bounded")
    return float(result.x)


def expected_calibration_error(probs: np.ndarray, targets: np.ndarray, bins: int = 15) -> float:
    confidence = probs.max(axis=1)
    correct = probs.argmax(axis=1) == targets
    edges = np.linspace(0.0, 1.0, bins + 1)
    ece = 0.0
    for low, high in zip(edges[:-1], edges[1:]):
        mask = (confidence > low) & (confidence <= high)
        if mask.any():
            ece += mask.mean() * abs(correct[mask].mean() - confidence[mask].mean())
    return float(ece)


def argmax_metrics(preds: np.ndarray, targets: np.ndarray) -> dict:
    matrix = [[int(np.sum((targets == t) & (preds == p))) for p in range(4)] for t in range(4)]
    per_class = {}
    f1s = []
    for c in range(4):
        tp = matrix[c][c]
        fp = sum(matrix[r][c] for r in range(4) if r != c)
        fn = sum(matrix[c][k] for k in range(4) if k != c)
        precision = tp / max(tp + fp, 1)
        recall = tp / max(tp + fn, 1)
        f1 = 2 * precision * recall / max(precision + recall, 1e-9)
        per_class[CLASSES[c]] = {"precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4), "support": int(sum(matrix[c]))}
        f1s.append(f1)
    return {
        "accuracy": round(float(np.mean(preds == targets)), 4) if len(targets) else None,
        "macro_f1": round(float(np.mean(f1s)), 4),
        "per_class": per_class,
        "confusion_matrix": matrix,
    }


def score_rows(classifier: ClaimClassifier, rows: list[dict]) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    logits, targets, kept = [], [], []
    skipped = Counter()
    for row in rows:
        assessable, _ = check_assessable(row["claim"])
        if not assessable:
            skipped["unassessable"] += 1
            continue
        sources = [{"citation": s.get("citation") or "", "text": s["text"], "unit_type": s.get("unit_type", "unknown")} for s in row["sources"]]
        raw = classifier.logits_for(row["claim"], sources)["logits"]
        if raw is None:
            skipped["unit_too_long"] += 1
            continue
        logits.append(raw)
        targets.append(CLASSES.index(row["label"]))
        kept.append(row)
    if skipped:
        print(f"  skipped: {dict(skipped)}")
    return np.array(logits, dtype=np.float32), np.array(targets), kept


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def fixture_source_text(path: Path) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8")
    if path.name.startswith(("nja", "hfd")):
        match = re.search(r"##\s+(?:Högsta\s+domstolen|Högsta\s+förvaltningsdomstolen)", text)
        return (text[match.start():] if match else text).strip(), "case_judgment"
    return text.strip(), "statute_provision"


def run_examples(classifier: ClaimClassifier, examples: list[dict], name: str) -> dict:
    results = []
    accepted = wrong = argmax_correct = assessed = 0
    for example in examples:
        result = classifier.predict_claim(example["claim"], [example["source"]])
        expected = example["expected"]
        comparison = result["comparisons"][0] if result["comparisons"] else None
        predicted = comparison.get("predicted_class") if comparison else None
        entry = {
            "id": example["id"], "expected": expected, "predicted": predicted,
            "label": result["label"], "abstain_reason": comparison.get("abstain_reason") if comparison else result["label"],
            "scores": comparison["scores"] if comparison else {},
        }
        results.append(entry)
        if expected is None or predicted is None:
            continue
        assessed += 1
        if predicted == expected:
            argmax_correct += 1
        if result["label"] != "abstain":
            accepted += 1
            if predicted != expected:
                wrong += 1
        flag = "" if predicted == expected else "   <-- argmax wrong"
        print(f"  {example['id']:<45} exp={expected:<11} pred={predicted:<11} conf={comparison['confidence']:.3f} {'ACCEPT' if result['label'] != 'abstain' else 'abstain':<7} {'WRONG' if result['label'] != 'abstain' and predicted != expected else ''}{flag}")
    summary = {"examples": len(examples), "assessed": assessed, "argmax_correct": argmax_correct, "accepted": accepted, "wrong_accepted": wrong,
               "precision_on_accepted": (accepted - wrong) / accepted if accepted else None}
    print(f"{name}: argmax correct {argmax_correct}/{assessed}; accepted {accepted}, wrong accepted {wrong}")
    return {"summary": summary, "results": results}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", default="models/classifier-kb-bert-4way")
    parser.add_argument("--cal-data", default="data/calibration.jsonl")
    parser.add_argument("--test-data", default="data/test.jsonl")
    parser.add_argument("--minimum-accepted", type=int, default=30)
    parser.add_argument("--wilson-slack", type=float, default=0.05)
    parser.add_argument("--no-wilson", action="store_true")
    parser.add_argument("--target-precision", action="append", default=[], metavar="CLASS=VALUE",
                        help="Override a class's target precision, e.g. supported=0.90. Repeatable.")
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--mode", choices=["window", "chunks"], default="window",
                        help="window: one BM25 window per claim (default); chunks: score every chunk and pool.")
    parser.add_argument("--report-dir", default=None, help="Where to write calibration.json and evaluation_report.json (default: model dir).")
    args = parser.parse_args()
    model_dir = Path(args.model_dir)
    report_dir = Path(args.report_dir) if args.report_dir else model_dir
    report_dir.mkdir(parents=True, exist_ok=True)

    classifier = ClaimClassifier(model_dir=model_dir, num_threads=args.threads)
    classifier.load()
    classifier.mode = args.mode

    print("Scoring calibration partition...")
    cal_logits, cal_targets, _ = score_rows(classifier, read_jsonl(Path(args.cal_data)))
    temperature = fit_temperature(cal_logits, cal_targets)
    cal_probs = softmax(cal_logits, temperature)
    target_precisions = {"supported": 0.95, "incorrect": 0.95, "unsupported": 0.90, "misleading": 0.90}
    for override in args.target_precision:
        class_name, value = override.split("=")
        if class_name not in target_precisions:
            parser.error(f"unknown class {class_name!r} in --target-precision")
        target_precisions[class_name] = float(value)
    selection = select_fail_closed_thresholds(
        cal_probs, cal_targets, CLASSES, target_precisions,
        minimum_accepted=args.minimum_accepted, use_wilson_lower_bound=not args.no_wilson, wilson_slack=args.wilson_slack,
    )
    thresholds = selection["thresholds"]
    minimum_margin = selection["minimum_margin"]
    print(f"Temperature {temperature:.4f}; thresholds {thresholds}; margin {minimum_margin}")
    for class_name, metrics in selection["class_metrics"].items():
        state = "enabled" if metrics["enabled"] else f"DISABLED ({metrics['failure_reason']})"
        print(f"  {class_name:<12} {state}; accepted={metrics['accepted']}, precision={metrics['empirical_precision']}, wilson={metrics['wilson_lower_bound']}")

    calibration = {
        "mode": args.mode,
        "temperature": round(temperature, 4),
        "minimum_margin": minimum_margin,
        "thresholds": thresholds,
        "ece_before": round(expected_calibration_error(softmax(cal_logits, 1.0), cal_targets), 4),
        "ece_after": round(expected_calibration_error(cal_probs, cal_targets), 4),
        "target_precisions": target_precisions,
        "calibration_rows": int(len(cal_targets)),
        "logits_source": "model_quantized.onnx via backend.model.ClaimClassifier",
        "selection": selection,
    }
    with (report_dir / "calibration.json").open("w", encoding="utf-8") as handle:
        json.dump(calibration, handle, indent=2, ensure_ascii=False)
    classifier.temperature = temperature
    classifier.min_margin = minimum_margin
    classifier.thresholds = dict(thresholds)

    print("Scoring test partition...")
    test_rows_all = read_jsonl(Path(args.test_data))
    test_logits, test_targets, test_rows = score_rows(classifier, test_rows_all)
    test_probs = softmax(test_logits, temperature)
    test_preds = test_probs.argmax(axis=1)
    overall = argmax_metrics(test_preds, test_targets)
    selective = selective_metrics(test_probs, test_targets, CLASSES, thresholds, minimum_margin)
    print(f"Test argmax accuracy {overall['accuracy']}, macro F1 {overall['macro_f1']}")
    print(f"Test selective: accepted {selective['accepted']}/{selective['total']}, precision {selective['precision_on_accepted']}")
    for class_name, metrics in selective["per_class"].items():
        print(f"  {class_name:<12} accepted={metrics['accepted']} precision={metrics['precision']}")

    groups: dict[str, dict[str, list[int]]] = {"unit_type": defaultdict(list), "family": defaultdict(list),
                                               "transformation": defaultdict(list), "teacher": defaultdict(list)}
    teacher_path = Path(args.test_data).parent / "teacher" / Path(args.test_data).name
    teacher = {}
    if teacher_path.exists():
        for verdict in read_jsonl(teacher_path):
            confident = verdict["teacher_label"] and max(verdict["teacher_probs"]) >= 0.8
            teacher[verdict["id"]] = ("confirmed" if verdict["teacher_label"] == verdict["label"]
                                      else "rejected" if confident else "unsure")
    for index, row in enumerate(test_rows):
        groups["unit_type"][row["sources"][0].get("unit_type", "unknown")].append(index)
        groups["family"]["provision_pairs" if row["id"].startswith("sfs_") else "judgment_derived"].append(index)
        groups["transformation"][row.get("transformation") or row.get("origin") or "unknown"].append(index)
        if row["id"] in teacher:
            groups["teacher"][teacher[row["id"]]].append(index)
    breakdown = {}
    for group_name, members in groups.items():
        breakdown[group_name] = {}
        for key, indices in sorted(members.items()):
            idx = np.array(indices)
            metrics = argmax_metrics(test_preds[idx], test_targets[idx])
            sel = selective_metrics(test_probs[idx], test_targets[idx], CLASSES, thresholds, minimum_margin)
            breakdown[group_name][key] = {"count": len(indices), "accuracy": metrics["accuracy"], "macro_f1": metrics["macro_f1"],
                                          "accepted": sel["accepted"], "precision_on_accepted": sel["precision_on_accepted"]}
            print(f"  {group_name}={key:<18} n={len(indices):<4} acc={metrics['accuracy']} accepted={sel['accepted']} prec={sel['precision_on_accepted']}")

    print("Source-grounding fixture:")
    grounding = json.loads(Path("test/fixtures/source-grounding.json").read_text(encoding="utf-8"))
    examples = []
    for example in grounding["examples"]:
        source = grounding["sources"][example["source_id"]]
        examples.append({"id": example["id"], "claim": example["claim"], "expected": example["expected"]["4way"],
                         "source": {"citation": source["citation"], "text": source["text"], "unit_type": "statute_provision"}})
    grounding_report = run_examples(classifier, examples, "source-grounding")

    print("Legal-claims fixture:")
    examples = []
    for claim in json.loads(Path("test/fixtures/legal-claims.json").read_text(encoding="utf-8")):
        text, unit_type = fixture_source_text(Path("test/fixtures/legal-sources") / claim["file"])
        examples.append({"id": claim["id"], "claim": claim["text"], "expected": FIXTURE_KIND.get(claim["kind"]),
                         "source": {"citation": claim["citation"], "text": text, "unit_type": unit_type}})
    fixture_report = run_examples(classifier, examples, "legal-claims")

    report = {
        "model_dir": str(model_dir),
        "calibration": calibration,
        "test_rows": int(len(test_targets)),
        "overall_test_metrics": overall,
        "held_out_selective_metrics": selective,
        "breakdown": breakdown,
        "source_grounding": grounding_report,
        "legal_claims_fixture": fixture_report,
    }
    with (report_dir / "evaluation_report.json").open("w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, ensure_ascii=False)
    print(f"Wrote {report_dir / 'calibration.json'} and {report_dir / 'evaluation_report.json'}")


if __name__ == "__main__":
    main()
