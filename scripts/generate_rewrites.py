#!/usr/bin/env python3
"""Generate new contradiction and overstatement rewrites of accepted parent claims, judged pairwise.

For every authentic or statute_memo row in an audited partition, the local LLM writes one contradiction
and one overstatement of the claim (temperature 0.7, so they differ from the existing rewrites). Each
rewrite is then judged next to the original claim with the pairwise teacher prompt from
audit_transformations_teacher.py, and kept only when the judged effect matches:

- contradiction kept as "incorrect" when judged B (other meaning);
- overstatement kept as "misleading" when judged C (more far-reaching), as "incorrect" when judged B;
- anything judged A (same meaning) or D is discarded.

Output: data/<split>.rewrites.jsonl in the partition row format, ids cf_incorr2_* and cf_mislead2_*.

    python scripts/generate_rewrites.py --split train.audited --split validation.audited
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from audit_labels_teacher import LETTERS, ask_letter  # noqa: E402
from audit_transformations_teacher import EFFECTS, SYSTEM as PAIR_SYSTEM, build_prompt as pair_prompt  # noqa: E402

PARENT_KINDS = {None, "statute_memo"}
PROMPTS = {
    "contradiction": (
        "Ändra ett väsentligt led i följande juridiska påstående så att det blir direkt felaktigt eller motsagt "
        "(t.ex. ändra utfall eller regel, invertera med negation, eller ändra en tidsfrist, ett belopp eller ett villkor). "
        "Påståendet ska fortfarande vara naturligt och auktoritativt skrivet på svenska och ungefär lika långt. "
        "Svara ENBART med det ändrade påståendet, utan citattecken, inledning eller förklaringar:\n"
    ),
    "overstatement": (
        "Gör följande juridiska påstående mer långtgående eller missvisande genom att överdriva regeln "
        "(t.ex. ta bort ett förbehåll eller undantag, ändra från 'får/kan' till ovillkorligt 'ska/måste', "
        "eller ta bort 'i regel'/'som huvudregel'). Ändra inte innebörden i övrigt. Påståendet ska fortfarande vara "
        "grammatiskt korrekt och naturligt på svenska. Svara ENBART med det ändrade påståendet, utan citattecken, "
        "inledning eller förklaringar:\n"
    ),
}
LABEL_FOR = {("contradiction", "contradiction"): "incorrect", ("overstatement", "overstatement"): "misleading",
             ("overstatement", "contradiction"): "incorrect"}


def generate(claim: str, kind: str, model: str, host: str, temperature: float) -> str | None:
    body = {"model": model, "messages": [{"role": "user", "content": PROMPTS[kind] + claim}],
            "stream": False, "think": False, "options": {"num_predict": 300, "temperature": temperature, "num_ctx": 32768}}
    request = urllib.request.Request(f"{host}/api/chat", data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                text = json.load(response)["message"]["content"].strip()
            break
        except Exception:  # noqa: BLE001
            if attempt == 2:
                return None
            time.sleep(5 * (attempt + 1))
    text = text.strip('"”“ \n')
    if not text or text == claim.strip() or len(text) < 0.5 * len(claim) or len(text) > 2.5 * len(claim) or "\n\n" in text:
        return None
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--split", action="append", default=None)
    parser.add_argument("--model", default="gemma4:26b")
    parser.add_argument("--host", default="http://localhost:11434")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--min-confidence", type=float, default=0.8)
    parser.add_argument("--per-source-chars", type=int, default=4000)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    for split in args.split or ["train.audited", "validation.audited"]:
        rows = [json.loads(line) for line in Path(f"data/{split}.jsonl").open(encoding="utf-8") if line.strip()]
        parents = [row for row in rows if row.get("transformation") in PARENT_KINDS][: args.limit]
        out_path = Path(f"data/{split.replace('.audited', '')}.rewrites.jsonl")
        done = set()
        if out_path.exists():
            done = {json.loads(line)["origin_claim_id"] + json.loads(line)["transformation"] for line in out_path.open(encoding="utf-8") if line.strip()}
        jobs = [(row, kind) for row in parents for kind in PROMPTS if row["origin_claim_id"] + kind not in done]
        print(f"{split}: {len(parents)} parents, {len(jobs)} rewrites to generate", file=sys.stderr, flush=True)
        stats = Counter()

        def work(job):
            row, kind = job
            text = generate(row["claim"], kind, args.model, args.host, args.temperature)
            if text is None:
                return None
            child = {**row, "claim": text, "label": None, "transformation": kind, "origin": "counterfactual"}
            answered, probs, _raw, _tokens = ask_letter(PAIR_SYSTEM, pair_prompt(child, row, args.per_source_chars),
                                                        args.model, args.host, 32768)
            effect = EFFECTS[LETTERS.index(answered)] if answered else None
            confident = effect is not None and probs[LETTERS.index(answered)] >= args.min_confidence
            label = LABEL_FOR.get((kind, effect)) if confident else None
            if label is None:
                return {"discard": f"{kind} judged {effect}"}
            prefix = "cf_incorr2" if label == "incorrect" else "cf_mislead2"
            digest = hashlib.md5(f"{row['origin_claim_id']}_{row['sources'][0]['source_id']}_{kind}2".encode("utf-8")).hexdigest()[:12]
            return {**child, "id": f"{prefix}_{digest}", "label": label, "actual_text": text,
                    "parent_id": row["id"], "judged_effect": effect}

        with out_path.open("a", encoding="utf-8") as handle, ThreadPoolExecutor(args.workers) as pool:
            for index, result in enumerate(pool.map(work, jobs), 1):
                if result is None:
                    stats["generation failed"] += 1
                elif "discard" in result:
                    stats[result["discard"]] += 1
                else:
                    stats[f"kept {result['label']}"] += 1
                    handle.write(json.dumps(result, ensure_ascii=False) + "\n")
                    handle.flush()
                if index % 100 == 0:
                    print(f"{split}: {index}/{len(jobs)} {dict(stats)}", file=sys.stderr, flush=True)
        print(f"{split}: done {dict(stats)} -> {out_path}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
