#!/usr/bin/env python3
"""Ask a local LLM (ollama) whether each transformed training row has the effect its label claims.

Rows made by rewriting a parent claim (paraphrase, contradiction, overstatement and their memo
variants) are shown next to the parent claim, so the teacher judges the change instead of hunting
for a single flipped word in a long source. The answer is one letter, read from the logprobs.

    A = same meaning and scope as the original
    B = says something else in substance (contradiction)
    C = goes further than the original (overstatement)
    D = differs in some other way

Output rows: id, transformation, expected, teacher_effect, teacher_probs, agree.

    python scripts/audit_transformations_teacher.py --split train --split validation
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from audit_labels_teacher import LETTERS, ask_letter  # noqa: E402

EFFECTS = ["same", "contradiction", "overstatement", "other"]
EXPECTED = {
    "paraphrase": "same",
    "contradiction": "contradiction", "contradiction_memo": "contradiction",
    "overstatement": "overstatement", "overstatement_memo": "overstatement",
}
PARENT_KINDS = {None, "statute_memo"}

SYSTEM = (
    "Du är en noggrann svensk jurist. Du får ett ursprungligt juridiskt påstående, en omskriven version "
    "av samma påstående och de källor påståendet hänvisar till. Bedöm hur den omskrivna versionen "
    "förhåller sig till den ursprungliga.\n"
    "A = Samma innebörd: den omskrivna versionen säger samma sak med samma räckvidd. Ändrad ordföljd, "
    "synonymer eller avstavning ändrar inte innebörden.\n"
    "B = Annan innebörd: den omskrivna versionen säger något annat i sak, till exempel motsatsen, en annan "
    "rättsföljd, ett annat villkor, en annan tidsfrist, ett annat begrepp eller en omkastad avvägning. "
    "Även ett enda utbytt ord räknas om det ändrar vad som påstås.\n"
    "C = Mer långtgående: den omskrivna versionen går längre än den ursprungliga. Ett förbehåll, undantag "
    "eller villkor har fallit bort, 'får/kan' har blivit 'ska/måste', eller 'i regel/som huvudregel' har "
    "blivit undantagslöst.\n"
    "D = Annan skillnad: den omskrivna versionen är snävare eller skiljer sig på ett sätt som inte är B eller C.\n"
    "Svara med exakt en bokstav: A, B, C eller D."
)


def build_prompt(row: dict, parent: dict, per_source_chars: int) -> str:
    parts = [f"[Källa {i}: {s['citation']}]\n{s['text'][:per_source_chars]}" for i, s in enumerate(row["sources"], 1)]
    return ("URSPRUNGLIGT PÅSTÅENDE:\n" + parent["claim"] + "\n\nOMSKRIVEN VERSION:\n" + row["claim"]
            + "\n\nKÄLLOR:\n" + "\n\n".join(parts) + "\n\nSvar (A/B/C/D):")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--split", action="append", default=None)
    parser.add_argument("--model", default="gemma4:26b")
    parser.add_argument("--host", default="http://localhost:11434")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--per-source-chars", type=int, default=4000)
    parser.add_argument("--num-ctx", type=int, default=32768)
    parser.add_argument("--out-dir", type=Path, default=Path("data/teacher"))
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--ids", default=None, help="Comma-separated row ids to judge (for spot checks).")
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for split in args.split or ["train", "validation"]:
        rows = [json.loads(line) for line in Path(f"data/{split}.jsonl").open(encoding="utf-8") if line.strip()]
        parents = {row["origin_claim_id"]: row for row in rows if row.get("transformation") in PARENT_KINDS}
        todo = [row for row in rows if row.get("transformation") in EXPECTED and row["origin_claim_id"] in parents]
        if args.ids:
            wanted = set(args.ids.split(","))
            todo = [row for row in todo if row["id"] in wanted]
        todo = todo[: args.limit]
        out_path = args.out_dir / f"{split}.pairs.jsonl"
        done = set()
        if out_path.exists():
            done = {json.loads(line)["id"] for line in out_path.open(encoding="utf-8") if line.strip()}
        todo = [row for row in todo if row["id"] not in done]
        print(f"{split}: {len(todo)} transformed rows to judge ({len(done)} already done)", file=sys.stderr, flush=True)

        def work(row: dict) -> dict:
            parent = parents[row["origin_claim_id"]]
            answered, probs, raw, tokens = ask_letter(SYSTEM, build_prompt(row, parent, args.per_source_chars),
                                                     args.model, args.host, args.num_ctx)
            effect = EFFECTS[LETTERS.index(answered)] if answered else None
            expected = EXPECTED[row["transformation"]]
            return {"id": row["id"], "label": row["label"], "transformation": row["transformation"], "parent_id": parent["id"],
                    "expected": expected, "teacher_effect": effect, "teacher_probs": [round(p, 4) for p in probs],
                    "agree": effect == expected, "prompt_tokens": tokens, "raw": raw}

        agree = 0
        with out_path.open("a", encoding="utf-8") as handle, ThreadPoolExecutor(args.workers) as pool:
            for index, result in enumerate(pool.map(work, todo), 1):
                handle.write(json.dumps(result, ensure_ascii=False) + "\n")
                handle.flush()
                agree += result["agree"]
                if index % 100 == 0:
                    print(f"{split}: {index}/{len(todo)} judged, agreement so far {agree / index:.3f}", file=sys.stderr, flush=True)
        print(f"{split}: done", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
