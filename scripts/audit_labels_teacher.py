#!/usr/bin/env python3
"""Ask a local LLM (ollama) to judge every claim/source pair and record where it disagrees
with the stored label.

Each row gets the full source texts (no BM25 window) and the four label definitions. The
answer is one letter; the probability over A-D is read from the logprobs of that token, so
the teacher's confidence is available without any generated explanation.

Output rows: id, label, teacher_label, teacher_probs, agree, prompt_tokens.

    python scripts/audit_labels_teacher.py --split train --split validation
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

LABELS = ["supported", "unsupported", "incorrect", "misleading"]
LETTERS = ["A", "B", "C", "D"]

SYSTEM = (
    "Du är en noggrann svensk jurist. Du får ett påstående ur en juridisk text och den eller de "
    "källor som påståendet hänvisar till. Bedöm hur källorna förhåller sig till påståendet.\n"
    "A = Stöds: källorna säger det som påståendet säger, i sak och med samma räckvidd. Att en av "
    "flera källor är irrelevant spelar ingen roll om någon källa ger stödet.\n"
    "B = Stöd saknas: källorna handlar om något annat, om en angränsande fråga, eller säger inte "
    "det påståendet säger. Källorna motsäger inte påståendet.\n"
    "C = Motsägs: källorna säger något annat än påståendet i sak, till exempel en annan rättsföljd, "
    "ett annat villkor, en annan tidsfrist eller motsatt regel.\n"
    "D = Vilseledande: källorna stödjer kärnan i påståendet, men påståendet är mer långtgående än "
    "källan: ett förbehåll, undantag eller villkor har fallit bort, 'får/kan' har blivit 'ska/måste', "
    "eller 'i regel/som huvudregel' har blivit undantagslöst.\n"
    "Svara med exakt en bokstav: A, B, C eller D."
)


def build_prompt(row: dict, per_source_chars: int) -> str:
    parts = [f"[Källa {i}: {s['citation']}]\n{s['text'][:per_source_chars]}" for i, s in enumerate(row["sources"], 1)]
    return "PÅSTÅENDE:\n" + row["claim"] + "\n\nKÄLLOR:\n" + "\n\n".join(parts) + "\n\nSvar (A/B/C/D):"


def ask_letter(system: str, prompt: str, model: str, host: str, num_ctx: int) -> tuple[str | None, list[float], str, int | None]:
    """Return (answered letter, probabilities over A-D, raw reply text, prompt tokens)."""
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        "stream": False, "think": False, "logprobs": True, "top_logprobs": 20,
        "options": {"num_predict": 8, "temperature": 0, "num_ctx": num_ctx},
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
    logprobs = {letter: -30.0 for letter in LETTERS}
    answered = None
    for step in reply.get("logprobs") or []:
        if step["token"].strip() in logprobs:
            answered = step["token"].strip()
            for entry in step["top_logprobs"]:
                token = entry["token"].strip()
                if token in logprobs:
                    logprobs[token] = max(logprobs[token], entry["logprob"])
            break
    weights = [math.exp(logprobs[letter]) for letter in LETTERS]
    total = sum(weights) or 1.0
    return answered, [w / total for w in weights], reply["message"]["content"][:40], reply.get("prompt_eval_count")


def ask(row: dict, model: str, host: str, per_source_chars: int, num_ctx: int) -> dict:
    answered, probs, raw, tokens = ask_letter(SYSTEM, build_prompt(row, per_source_chars), model, host, num_ctx)
    teacher = LABELS[LETTERS.index(answered)] if answered else None
    return {
        "id": row["id"], "label": row["label"], "origin": row.get("origin"), "transformation": row.get("transformation"),
        "teacher_label": teacher, "teacher_probs": [round(p, 4) for p in probs], "agree": teacher == row["label"],
        "prompt_tokens": tokens, "raw": raw,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--split", action="append", default=None, help="Partition name under data/ (repeatable).")
    parser.add_argument("--model", default="gemma4:26b")
    parser.add_argument("--host", default="http://localhost:11434")
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--per-source-chars", type=int, default=12000)
    parser.add_argument("--num-ctx", type=int, default=32768)
    parser.add_argument("--out-dir", type=Path, default=Path("data/teacher"))
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for split in args.split or ["train", "validation", "calibration", "test"]:
        rows = [json.loads(line) for line in Path(f"data/{split}.jsonl").open(encoding="utf-8") if line.strip()]
        rows = rows[: args.limit]
        out_path = args.out_dir / f"{split}.jsonl"
        done = set()
        if out_path.exists():
            done = {json.loads(line)["id"] for line in out_path.open(encoding="utf-8") if line.strip()}
        todo = [row for row in rows if row["id"] not in done]
        print(f"{split}: {len(rows)} rows, {len(done)} already judged, {len(todo)} to do", file=sys.stderr, flush=True)
        agree = 0
        with out_path.open("a", encoding="utf-8") as handle, ThreadPoolExecutor(args.workers) as pool:
            work = (lambda row: ask(row, args.model, args.host, args.per_source_chars, args.num_ctx))
            for index, result in enumerate(pool.map(work, todo), 1):
                handle.write(json.dumps(result, ensure_ascii=False) + "\n")
                handle.flush()
                agree += result["agree"]
                if index % 100 == 0:
                    print(f"{split}: {index}/{len(todo)} judged, agreement so far {agree / index:.3f}", file=sys.stderr, flush=True)
        print(f"{split}: done", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
