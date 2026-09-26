#!/usr/bin/env python3
"""Ask a local LLM (ollama) which chunk of a row's sources its label rests on.

Chunk-level training pairs need a chunk label. For a row labelled supported, incorrect or
misleading, the teacher sees the claim and the numbered chunks (backend.windowing.source_chunks)
and answers with the number of the passage that supports, contradicts or is overstated by the
claim, or 0 when no single passage does. Rows with one chunk need no call.

Output rows: id, label, n_chunks, chunk (0-based index or null), raw.

    python scripts/select_chunks_teacher.py --split train.audited --split validation.audited
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.windowing import source_chunks  # noqa: E402

SYSTEM = (
    "Du är en noggrann svensk jurist. Du får ett påstående, dess bedömning och de numrerade avsnitt "
    "som utgör källorna. Ange numret på det avsnitt som bedömningen vilar på:\n"
    "- Stöds: avsnittet som säger det påståendet säger.\n"
    "- Motsägs: avsnittet som säger något annat än påståendet.\n"
    "- Vilseledande: avsnittet som påståendet överdriver eller vars förbehåll påståendet utelämnar.\n"
    "Svara med enbart ett heltal. Svara 0 om inget enskilt avsnitt bär bedömningen."
)
VERDICT = {"supported": "Stöds", "incorrect": "Motsägs", "misleading": "Vilseledande"}


def build_prompt(row: dict, chunks: list[dict], per_chunk_chars: int) -> str:
    parts = [f"[{i}] ({c['citation']}) {c['text'][:per_chunk_chars]}" for i, c in enumerate(chunks, 1)]
    return (f"PÅSTÅENDE:\n{row['claim']}\n\nBEDÖMNING: {VERDICT[row['label']]}\n\nAVSNITT:\n" + "\n\n".join(parts)
            + "\n\nSvar (avsnittets nummer, eller 0):")


def ask(row: dict, chunks: list[dict], model: str, host: str, per_chunk_chars: int, num_ctx: int) -> dict:
    body = {
        "model": model,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": build_prompt(row, chunks, per_chunk_chars)}],
        "stream": False, "think": False,
        "options": {"num_predict": 12, "temperature": 0, "num_ctx": num_ctx},
    }
    request = urllib.request.Request(f"{host}/api/chat", data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=1800) as response:
                reply = json.load(response)
            break
        except Exception:  # noqa: BLE001
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))
    raw = reply["message"]["content"].strip()
    match = re.search(r"\d+", raw)
    number = int(match.group()) if match else None
    chunk = number - 1 if number and 1 <= number <= len(chunks) else None
    return {"id": row["id"], "label": row["label"], "n_chunks": len(chunks), "chunk": chunk, "raw": raw[:20]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--split", action="append", default=None, help="Partition file stem under data/ (repeatable).")
    parser.add_argument("--model", default="gemma4:26b")
    parser.add_argument("--host", default="http://localhost:11434")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--per-chunk-chars", type=int, default=1500)
    parser.add_argument("--num-ctx", type=int, default=32768)
    parser.add_argument("--out-dir", type=Path, default=Path("data/teacher"))
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for split in args.split or ["train.audited", "validation.audited"]:
        rows = [json.loads(line) for line in Path(f"data/{split}.jsonl").open(encoding="utf-8") if line.strip()]
        out_path = args.out_dir / f"{split}.chunks.jsonl"
        done = set()
        if out_path.exists():
            done = {json.loads(line)["id"] for line in out_path.open(encoding="utf-8") if line.strip()}
        todo = []
        for row in rows:
            if row["label"] not in VERDICT or row["id"] in done:
                continue
            chunks = source_chunks(row["sources"])
            if len(chunks) > 1:
                todo.append((row, chunks))
        todo = todo[: args.limit]
        print(f"{split}: {len(todo)} multi-chunk rows to judge ({len(done)} already done)", file=sys.stderr, flush=True)
        none_count = 0
        with out_path.open("a", encoding="utf-8") as handle, ThreadPoolExecutor(args.workers) as pool:
            work = (lambda item: ask(item[0], item[1], args.model, args.host, args.per_chunk_chars, args.num_ctx))
            for index, result in enumerate(pool.map(work, todo), 1):
                handle.write(json.dumps(result, ensure_ascii=False) + "\n")
                handle.flush()
                none_count += result["chunk"] is None
                if index % 100 == 0:
                    print(f"{split}: {index}/{len(todo)} judged, no single chunk for {none_count}", file=sys.stderr, flush=True)
        print(f"{split}: done, no single chunk for {none_count}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
