#!/usr/bin/env python3
"""Turn audited rows into chunk-level training pairs for sentence-level alignment.

Each row's sources are chunked with backend.windowing.source_chunks, the same function the
server scores with. Labels per chunk:

- unsupported rows: every chunk is unsupported (at most --negatives-per-row of them, chosen at random);
- supported, incorrect and misleading rows with one chunk: that chunk carries the row label;
- with several chunks: the chunk the teacher picked (data/teacher/<split>.chunks.jsonl) carries the
  row label and at most --negatives-per-row of the others are unsupported. Rows where the teacher
  found no single chunk are skipped.

Output rows keep the input format (one source per row), so scripts/train_kb_bert.py trains on
them unchanged. Ids are <row id>#c<chunk index>.

    python scripts/build_chunk_pairs.py --split train.audited --split validation.audited
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.windowing import source_chunks  # noqa: E402


def chunk_row(row: dict, chunk: dict, label: str, transformation: str | None) -> dict:
    source = row["sources"][chunk["source_idx"]]
    return {
        **row,
        "id": f"{row['id']}#c{chunk['index']}",
        "label": label,
        "transformation": transformation,
        "sources": [{**source, "text": chunk["text"]}],
        "chunk_of": row["id"],
    }


def resolve_pick(row: dict, chunks: list[dict], picks: dict, by_id: dict) -> int | None:
    """The deciding chunk index for a row: its own teacher pick, or, for a rewrite of the same
    source, the parent's pick mapped onto this row's chunks by source unit and text."""
    if len(chunks) == 1:
        return 0
    if picks.get(row["id"]) is not None:
        return picks[row["id"]]
    parent_id = row.get("parent_id")
    if parent_id is None:
        parent_id = next((pid for pid, candidate in by_id.items()
                          if candidate["origin_claim_id"] == row["origin_claim_id"]
                          and candidate.get("transformation") in (None, "statute_memo")), None)
    parent = by_id.get(parent_id) if parent_id else None
    if parent is None or picks.get(parent_id) is None:
        return None
    parent_chunks = source_chunks(parent["sources"])
    if picks[parent_id] >= len(parent_chunks):
        return None
    target = parent_chunks[picks[parent_id]]
    target_unit = parent["sources"][target["source_idx"]]["source_id"]
    for chunk in chunks:
        if row["sources"][chunk["source_idx"]]["source_id"] == target_unit and chunk["text"] == target["text"]:
            return chunk["index"]
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--split", action="append", default=None)
    parser.add_argument("--negatives-per-row", type=int, default=2)
    parser.add_argument("--teacher-dir", type=Path, default=Path("data/teacher"))
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--extra", action="append", default=[],
                        help="Extra row files (rewrites, neighbour chunks) merged into the split they belong to, "
                             "given as <split>=<path>; rows with one short source pass through as single chunks.")
    args = parser.parse_args()
    rng = random.Random(args.seed)

    for split in args.split or ["train.audited", "validation.audited"]:
        rows = [json.loads(line) for line in Path(f"data/{split}.jsonl").open(encoding="utf-8") if line.strip()]
        for extra in args.extra:
            name, _, path = extra.partition("=")
            if name == split and Path(path).exists():
                rows += [json.loads(line) for line in Path(path).open(encoding="utf-8") if line.strip()]
        picks = {}
        pick_path = args.teacher_dir / f"{split}.chunks.jsonl"
        if pick_path.exists():
            for line in pick_path.open(encoding="utf-8"):
                if line.strip():
                    pick = json.loads(line)
                    picks[pick["id"]] = pick["chunk"]
        by_id = {row["id"]: row for row in rows}
        out_path = Path(f"data/{split.replace('.audited', '')}.chunks.jsonl")
        stats, labels = Counter(), Counter()
        with out_path.open("w", encoding="utf-8") as handle:
            for row in rows:
                chunks = source_chunks(row["sources"])
                if not chunks:
                    stats["no chunks"] += 1
                    continue
                if row["label"] == "unsupported":
                    chosen = rng.sample(chunks, min(args.negatives_per_row, len(chunks)))
                    out = [chunk_row(row, c, "unsupported", row.get("transformation")) for c in chosen]
                    stats["unsupported rows"] += 1
                else:
                    positive = resolve_pick(row, chunks, picks, by_id)
                    if positive is None:
                        stats["skipped: no chunk pick"] += 1
                        continue
                    if picks.get(row["id"]) is None and len(chunks) > 1:
                        stats["pick taken from parent"] += 1
                    out = [chunk_row(row, chunks[positive], row["label"], row.get("transformation"))]
                    others = [c for c in chunks if c["index"] != positive]
                    for c in rng.sample(others, min(args.negatives_per_row, len(others))):
                        out.append(chunk_row(row, c, "unsupported", f"other_chunk_of_{row['label']}"))
                    stats["positive rows"] += 1
                for item in out:
                    labels[item["label"]] += 1
                    handle.write(json.dumps(item, ensure_ascii=False) + "\n")
        print(f"{split}: {dict(stats)} -> {out_path} with {sum(labels.values())} chunk pairs {dict(labels)}")


if __name__ == "__main__":
    main()
