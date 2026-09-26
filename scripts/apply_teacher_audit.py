#!/usr/bin/env python3
"""Drop training rows whose stored label the teacher rejects with confidence.

Reads data/<split>.jsonl, data/teacher/<split>.jsonl (label audit), data/teacher/<split>.pairs.jsonl
(pairwise audit of rewritten rows) and data/teacher/<split>.repairs.jsonl (re-resolved sources the
teacher accepted, see repair_rejected_sources.py), writes data/<split>.audited.jsonl and prints the drop rate per
transformation. Three rules, each only acting on verdicts with probability >= --min-confidence:

1. Parent rule. If the teacher finds an authentic or statute_memo claim not supported by its source,
   every row derived from it whose label assumes that support is dropped: paraphrase, distractor_source,
   reordered_sources, contradiction and overstatement rows. Rows labelled unsupported stay.
2. Pair rule. A contradiction row stays only if the teacher saw a change in substance (B). An overstatement
   row stays if the teacher saw a change in substance or scope (B or C). A paraphrase row stays only if the
   teacher saw no change (A). Rows without a pairwise verdict fall through to rule 3.
3. Label rule. Any other row is dropped when the teacher's label differs from the stored one.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

LABELS = ["supported", "unsupported", "incorrect", "misleading"]
EFFECTS = ["same", "contradiction", "overstatement", "other"]
PARENT_KINDS = {None, "statute_memo"}
DEPENDS_ON_PARENT = {"paraphrase", "distractor_source", "reordered_sources",
                     "contradiction", "contradiction_memo", "overstatement", "overstatement_memo"}
ACCEPTED_EFFECTS = {
    "paraphrase": {"same"},
    "contradiction": {"contradiction"}, "contradiction_memo": {"contradiction"},
    "overstatement": {"contradiction", "overstatement"}, "overstatement_memo": {"contradiction", "overstatement"},
}


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.open(encoding="utf-8") if line.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--split", action="append", default=None)
    parser.add_argument("--min-confidence", type=float, default=0.8)
    parser.add_argument("--teacher-dir", type=Path, default=Path("data/teacher"))
    parser.add_argument("--review-out", type=Path, default=None,
                        help="Write every row the rules would drop, with claim, parent claim, sources and verdicts, for review.")
    parser.add_argument("--decisions", type=Path, default=None,
                        help="JSONL of reviewer decisions {id, decision: keep|drop|relabel, label?}; overrides the rules.")
    args = parser.parse_args()
    decisions = {}
    if args.decisions and args.decisions.exists():
        decisions = {d["id"]: d for d in read_jsonl(args.decisions)}

    for split in args.split or ["train", "validation"]:
        rows = read_jsonl(Path(f"data/{split}.jsonl"))
        labels = {v["id"]: v for v in read_jsonl(args.teacher_dir / f"{split}.jsonl")}
        pairs = {v["id"]: v for v in read_jsonl(args.teacher_dir / f"{split}.pairs.jsonl")}
        repairs = {v["id"]: v for v in read_jsonl(args.teacher_dir / f"{split}.repairs.jsonl")}
        # A repaired parent that the teacher now accepts replaces its old verdict; the label
        # verdicts of its siblings were made on the broken source text and are discarded.
        for repair in repairs.values():
            if repair.get("accepted"):
                labels[repair["id"]] = {**labels.get(repair["id"], {}), "teacher_label": "supported",
                                        "teacher_probs": repair["teacher_probs"]}
            elif "parent_id" in repair:
                labels.pop(repair["id"], None)
        repaired_sources = {v["id"]: v["sources"] for v in repairs.values()
                            if v.get("accepted") or ("parent_id" in v and repairs.get(v["parent_id"], {}).get("accepted"))}

        bad_parents = set()
        for row in rows:
            verdict = labels.get(row["id"])
            if row.get("transformation") in PARENT_KINDS and verdict and verdict["teacher_label"] not in (None, "supported"):
                if verdict["teacher_probs"][LABELS.index(verdict["teacher_label"])] >= args.min_confidence:
                    bad_parents.add(row["origin_claim_id"])

        kept, total, reasons = Counter(), Counter(), Counter()
        parents = {row["origin_claim_id"]: row for row in rows if row.get("transformation") in PARENT_KINDS}
        review = []
        out_path = Path(f"data/{split}.audited.jsonl")
        with out_path.open("w", encoding="utf-8") as handle:
            for row in rows:
                kind = row.get("transformation") or row.get("origin")
                total[kind] += 1
                drop = None
                if row["origin_claim_id"] in bad_parents and (kind in DEPENDS_ON_PARENT or row.get("transformation") in PARENT_KINDS):
                    drop = "parent not supported"
                elif row["id"] in pairs and pairs[row["id"]]["teacher_effect"]:
                    pair = pairs[row["id"]]
                    effect = pair["teacher_effect"]
                    confident = pair["teacher_probs"][EFFECTS.index(effect)] >= args.min_confidence
                    if confident and effect not in ACCEPTED_EFFECTS[row["transformation"]]:
                        drop = f"rewrite judged '{effect}'"
                elif row["id"] in labels and labels[row["id"]]["teacher_label"]:
                    verdict = labels[row["id"]]
                    teacher = verdict["teacher_label"]
                    if teacher != row["label"] and verdict["teacher_probs"][LABELS.index(teacher)] >= args.min_confidence:
                        drop = f"{row['label']} judged {teacher}"
                if row["id"] in repaired_sources:
                    row = {**row, "sources": repaired_sources[row["id"]]}
                    reasons[(kind, "sources repaired")] += 1
                if drop and args.review_out is not None:
                    parent = parents.get(row["origin_claim_id"])
                    review.append({"id": row["id"], "transformation": row.get("transformation"), "label": row["label"],
                                   "rule": drop, "claim": row["claim"],
                                   "parent_claim": parent["claim"] if parent and parent["id"] != row["id"] else None,
                                   "teacher_label": (labels.get(row["id"]) or {}).get("teacher_label"),
                                   "pair_effect": (pairs.get(row["id"]) or {}).get("teacher_effect"),
                                   "sources": [{"citation": s.get("citation"), "unit_type": s.get("unit_type"),
                                                "text": s["text"][:4000]} for s in row["sources"]]})
                decision = decisions.get(row["id"])
                if decision:
                    if decision["decision"] == "drop":
                        drop = "reviewer: drop"
                    elif decision["decision"] == "relabel":
                        row = {**row, "label": decision["label"]}
                        reasons[(kind, f"reviewer: relabel to {decision['label']}")] += 1
                        drop = None
                    else:
                        drop = None
                if drop:
                    reasons[(kind, drop)] += 1
                    continue
                kept[kind] += 1
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        if args.review_out is not None:
            args.review_out.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in review) + "\n", encoding="utf-8")
            print(f"{split}: {len(review)} rows for review -> {args.review_out}")

        print(f"{split}: kept {sum(kept.values())} of {len(rows)} rows "
              f"(label verdicts {len(labels)}, pair verdicts {len(pairs)}, rejected parents {len(bad_parents)}) -> {out_path}")
        for kind in sorted(total, key=lambda k: -total[k]):
            print(f"  {kind:22s} kept {kept[kind]:5d} / {total[kind]:5d}  dropped {(1 - kept[kind] / total[kind]):.0%}")
        print("  drop reasons (and repairs):")
        for (kind, reason), count in reasons.most_common():
            print(f"    {count:5d}  {kind:22s} {reason}")
        remaining = Counter(json.loads(line)["label"] for line in out_path.open(encoding="utf-8"))
        print("  labels after:", dict(remaining))


if __name__ == "__main__":
    main()
