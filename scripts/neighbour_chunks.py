#!/usr/bin/env python3
"""Make high-overlap negatives from the chunks next to a claim's deciding chunk, judged one by one.

For every supported, incorrect or misleading row with a chunk pick (its own, or its parent's for a
rewrite of the same source), the chunks immediately before and after the deciding chunk in the same
source are judged against the claim by the label teacher, one chunk as the only source. A chunk judged
B (unsupported) with confidence becomes an unsupported row; one judged A (supported) becomes a supported
row, since a neighbouring paragraph of förarbeten or domskäl often restates the point. Others are dropped.

Output: data/<split>.neighbours.jsonl, one source per row, ids <row id>#n<chunk index>.

    python scripts/neighbour_chunks.py --split train.audited --split validation.audited
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from backend.windowing import source_chunks  # noqa: E402
from audit_labels_teacher import LABELS, LETTERS, SYSTEM, build_prompt, ask_letter  # noqa: E402
from build_chunk_pairs import chunk_row, resolve_pick  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--split", action="append", default=None)
    parser.add_argument("--model", default="gemma4:26b")
    parser.add_argument("--host", default="http://localhost:11434")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--min-confidence", type=float, default=0.8)
    parser.add_argument("--teacher-dir", type=Path, default=Path("data/teacher"))
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    for split in args.split or ["train.audited", "validation.audited"]:
        rows = [json.loads(line) for line in Path(f"data/{split}.jsonl").open(encoding="utf-8") if line.strip()]
        picks = {}
        for line in (args.teacher_dir / f"{split}.chunks.jsonl").open(encoding="utf-8"):
            if line.strip():
                pick = json.loads(line)
                picks[pick["id"]] = pick["chunk"]
        by_id = {row["id"]: row for row in rows}
        out_path = Path(f"data/{split.replace('.audited', '')}.neighbours.jsonl")
        done = set()
        if out_path.exists():
            done = {json.loads(line)["id"].split("#")[0] for line in out_path.open(encoding="utf-8") if line.strip()}
        # Judge each neighbour once, for the parent claim. An unsupported verdict carries over to the
        # rewrites of that claim that cite the same unit: a chunk that does not address a claim does not
        # address its negation or its overstatement either. A supported verdict stays with the parent.
        by_origin = defaultdict(list)
        for row in rows:
            by_origin[row["origin_claim_id"]].append(row)
        jobs = []
        for row in rows:
            if row.get("transformation") not in (None, "statute_memo") or row["label"] == "unsupported" or row["id"] in done:
                continue
            chunks = source_chunks(row["sources"])
            positive = resolve_pick(row, chunks, picks, by_id)
            if positive is None or len(chunks) < 2:
                continue
            for neighbour in (positive - 1, positive + 1):
                if 0 <= neighbour < len(chunks) and chunks[neighbour]["source_idx"] == chunks[positive]["source_idx"]:
                    jobs.append((row, chunks[neighbour]))
        jobs = jobs[: args.limit]
        print(f"{split}: {len(jobs)} neighbour chunks to judge", file=sys.stderr, flush=True)
        stats = Counter()

        def siblings_with_chunk(row, chunk):
            unit = row["sources"][chunk["source_idx"]]["source_id"]
            for sibling in by_origin[row["origin_claim_id"]]:
                if sibling["id"] == row["id"] or sibling["label"] == "unsupported":
                    continue
                for candidate in source_chunks(sibling["sources"]):
                    if sibling["sources"][candidate["source_idx"]]["source_id"] == unit and candidate["text"] == chunk["text"]:
                        yield sibling, candidate
                        break

        def work(job):
            row, chunk = job
            candidate = chunk_row(row, chunk, "unsupported", "neighbour_chunk")
            candidate["id"] = f"{row['id']}#n{chunk['index']}"
            answered, probs, _raw, _tokens = ask_letter(SYSTEM, build_prompt(candidate, 12000), args.model, args.host, 32768)
            label = LABELS[LETTERS.index(answered)] if answered else None
            confident = label is not None and probs[LETTERS.index(answered)] >= args.min_confidence
            if not confident or label not in ("supported", "unsupported"):
                return {"discard": f"judged {label}"}
            return {**candidate, "label": label, "transformation": f"neighbour_{label}", "teacher_probs": [round(p, 4) for p in probs]}

        with out_path.open("a", encoding="utf-8") as handle, ThreadPoolExecutor(args.workers) as pool:
            for index, result in enumerate(pool.map(work, jobs), 1):
                if "discard" in result:
                    stats[result["discard"]] += 1
                else:
                    stats[f"kept {result['label']}"] += 1
                    handle.write(json.dumps(result, ensure_ascii=False) + "\n")
                    if result["label"] == "unsupported":
                        row, chunk = jobs[index - 1]
                        for sibling, candidate in siblings_with_chunk(row, chunk):
                            copy = chunk_row(sibling, candidate, "unsupported", "neighbour_unsupported")
                            copy["id"] = f"{sibling['id']}#n{candidate['index']}"
                            handle.write(json.dumps(copy, ensure_ascii=False) + "\n")
                            stats["copied to siblings"] += 1
                    handle.flush()
                if index % 200 == 0:
                    print(f"{split}: {index}/{len(jobs)} {dict(stats)}", file=sys.stderr, flush=True)
        print(f"{split}: done {dict(stats)} -> {out_path}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
