#!/usr/bin/env python3
"""Re-resolve the sources of rows the teacher rejected and ask the teacher again.

For every authentic or statute_memo row whose stored label the teacher rejected with confidence,
each source is resolved again through backend.resolver (which now reads CJEU pinpoints written
"p. 49", takes the betänkande as reasoning when the court adopted it, keeps the numbered points of
a provision and adds the following page for "s. 83 f."). When any source text changed, the teacher
judges the row again on the new text. Rows the teacher now accepts are written with their new
sources, and the new source texts are propagated to the sibling rows that cite the same unit.

Output: data/teacher/<split>.repairs.jsonl with one row per changed row:
    id, sources, changed (source ids), teacher_label, teacher_probs (parents only), parent_id (children only)

    python scripts/repair_rejected_sources.py --split train --split validation
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from backend.resolver import CitedUnitResolver  # noqa: E402
from audit_labels_teacher import LABELS, LETTERS, SYSTEM, build_prompt, ask_letter  # noqa: E402

PARENT_KINDS = {None, "statute_memo"}


def normalized(text: str) -> str:
    return " ".join(text.split())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--split", action="append", default=None)
    parser.add_argument("--model", default="gemma4:26b")
    parser.add_argument("--host", default="http://localhost:11434")
    parser.add_argument("--min-confidence", type=float, default=0.8)
    parser.add_argument("--per-source-chars", type=int, default=30000)
    parser.add_argument("--num-ctx", type=int, default=32768)
    parser.add_argument("--teacher-dir", type=Path, default=Path("data/teacher"))
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--repair-all", action="store_true",
                        help="Re-resolve the sources of every parent row. Changed text on a row the teacher accepted "
                             "is taken without asking again (the resolver fixes are bug fixes); rejected rows are re-asked.")
    args = parser.parse_args()

    resolver = CitedUnitResolver()
    resolved: dict[str, str | None] = {}

    def resolve(source: dict) -> str | None:
        key = source["source_id"] + "|" + source.get("citation", "")
        if key not in resolved:
            result = resolver.resolve(f"https://lagen.nu/{source['source_id']}", citation=source.get("citation", ""))
            resolved[key] = result["text"].strip() if result.get("status") == "ok" and result.get("text") else None
        return resolved[key]

    for split in args.split or ["train", "validation"]:
        rows = [json.loads(line) for line in Path(f"data/{split}.jsonl").open(encoding="utf-8") if line.strip()]
        verdicts = {}
        for line in (args.teacher_dir / f"{split}.jsonl").open(encoding="utf-8"):
            if line.strip():
                verdict = json.loads(line)
                verdicts[verdict["id"]] = verdict
        by_origin = defaultdict(list)
        for row in rows:
            by_origin[row["origin_claim_id"]].append(row)

        rejected, accepted_parents = [], []
        for row in rows:
            verdict = verdicts.get(row["id"])
            if row.get("transformation") not in PARENT_KINDS:
                continue
            confident_reject = (verdict and verdict["teacher_label"] not in (None, "supported")
                                and verdict["teacher_probs"][LABELS.index(verdict["teacher_label"])] >= args.min_confidence)
            if confident_reject:
                rejected.append(row)
            elif args.repair_all:
                accepted_parents.append(row)
        rejected = rejected[: args.limit]
        print(f"{split}: {len(rejected)} rejected parent rows, {len(accepted_parents)} accepted parents to re-resolve",
              file=sys.stderr, flush=True)

        out_path = args.teacher_dir / f"{split}.repairs.jsonl"
        stats = defaultdict(int)
        def propagate(handle, row, new_sources, changed):
            replacements = {s["source_id"]: s["text"] for s in new_sources if s["source_id"] in changed}
            for sibling in by_origin[row["origin_claim_id"]]:
                if sibling["id"] == row["id"] or not any(s["source_id"] in replacements for s in sibling["sources"]):
                    continue
                sibling_sources = [{**s, "text": replacements.get(s["source_id"], s["text"])} for s in sibling["sources"]]
                handle.write(json.dumps({"id": sibling["id"], "parent_id": row["id"], "sources": sibling_sources,
                                         "changed": [s["source_id"] for s in sibling["sources"] if s["source_id"] in replacements]},
                                        ensure_ascii=False) + "\n")
                stats["siblings updated"] += 1

        with out_path.open("w", encoding="utf-8") as handle:
            for row in accepted_parents:
                new_sources, changed = [], []
                for source in row["sources"]:
                    text = resolve(source)
                    if text and normalized(text) != normalized(source["text"]):
                        changed.append(source["source_id"])
                        new_sources.append({**source, "text": text})
                    else:
                        new_sources.append(source)
                if changed:
                    stats["accepted parents re-resolved"] += 1
                    handle.write(json.dumps({"id": row["id"], "sources": new_sources, "changed": changed, "teacher_label": "supported",
                                             "teacher_probs": None, "accepted": True, "mechanical": True}, ensure_ascii=False) + "\n")
                    propagate(handle, row, new_sources, changed)
            for index, row in enumerate(rejected, 1):
                new_sources, changed = [], []
                for source in row["sources"]:
                    text = resolve(source)
                    if text and normalized(text) != normalized(source["text"]):
                        changed.append(source["source_id"])
                        new_sources.append({**source, "text": text})
                    else:
                        new_sources.append(source)
                if not changed:
                    stats["unchanged"] += 1
                    continue
                answered, probs, _raw, _tokens = ask_letter(SYSTEM, build_prompt({**row, "sources": new_sources}, args.per_source_chars),
                                                            args.model, args.host, args.num_ctx)
                label = LABELS[LETTERS.index(answered)] if answered else None
                accepted = label == "supported" and probs[0] >= args.min_confidence
                stats["accepted" if accepted else "still rejected"] += 1
                handle.write(json.dumps({"id": row["id"], "sources": new_sources, "changed": changed, "teacher_label": label,
                                         "teacher_probs": [round(p, 4) for p in probs], "accepted": accepted}, ensure_ascii=False) + "\n")
                if accepted:
                    propagate(handle, row, new_sources, changed)
                handle.flush()
                if index % 25 == 0:
                    print(f"{split}: {index}/{len(rejected)} {dict(stats)}", file=sys.stderr, flush=True)
        print(f"{split}: done {dict(stats)} -> {out_path}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
