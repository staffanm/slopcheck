#!/usr/bin/env python3
"""
Fill the empty source texts of the thesis pairs from lagen.nu's document endpoint.

thesis_llm_pairs.py keeps a source whose pinpoint lagen.nu could not cut out with
an empty text. This script resolves each empty source again with
CitedUnitResolver (source_id and citation, as the pair was built), writes the
text into the row, recomputes token_length and rewrites the part files in place.
Sources lagen.nu still cannot cut out stay empty; they are listed in
<first part>.missing.jsonl with lagen.nu's reason, so a later run can try again.

Usage: python scripts/fill_thesis_sources.py data/thesises-training.part*.jsonl [--workers 8]
"""

import argparse
import concurrent.futures
import json
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

from transformers import AutoTokenizer

from backend.resolver import CitedUnitResolver, format_premise


def reason(uri):
    """lagen.nu's own words for a pinpoint it cannot cut out."""
    url = f"https://lagen.nu/api/v1/document?{urllib.parse.urlencode({'uri': uri, 'format': 'md'})}"
    try:
        urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "slopcheck-fill"}), timeout=60)
        return "found on retry"
    except urllib.error.HTTPError as error:
        return json.loads(error.read() or b"{}").get("detail", f"HTTP {error.code}")
    except Exception as error:
        return f"unreachable: {error}"


def main():
    parser = argparse.ArgumentParser(description="Fill empty thesis source texts from lagen.nu.")
    parser.add_argument("parts", nargs="+", type=Path)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--model-name", default="BalaRajesh1/mmbert-small-nli", help="tokenizer for token_length, as in thesis_llm_pairs.py")
    args = parser.parse_args()

    parts = {path: [json.loads(line) for line in path.open(encoding="utf-8") if line.strip()] for path in args.parts}
    keys = sorted({(s["source_id"], s["citation"]) for rows in parts.values() for r in rows for s in r["sources"] if not s["text"].strip()})
    print(f"{len(keys)} distinct empty sources", flush=True)

    resolver = CitedUnitResolver()

    def fill(key):
        source_id, citation = key
        res = resolver.resolve(f"https://lagen.nu/{source_id}", citation=citation)
        if res.get("status") == "ok" and res.get("text", "").strip():
            return key, res["text"].strip(), None
        return key, "", res.get("abstain_reason") or "unknown"

    texts, failed = {}, {}
    with concurrent.futures.ThreadPoolExecutor(args.workers) as pool:
        for n, (key, text, why) in enumerate(pool.map(fill, keys), 1):
            if text:
                texts[key] = text
            else:
                failed[key] = why
            if n % 500 == 0:
                print(f"  {n}/{len(keys)}: {len(texts)} filled", flush=True)
        details = dict(zip(failed, pool.map(lambda key: reason(f"https://lagen.nu/{key[0]}"), failed)))

    tokenizer = AutoTokenizer.from_pretrained(args.model_name)
    stats = Counter()
    for path, rows in parts.items():
        for row in rows:
            changed = False
            for source in row["sources"]:
                key = (source["source_id"], source["citation"])
                if not source["text"].strip():
                    if key in texts:
                        source["text"] = texts[key]
                        changed = True
                        stats[f"filled {source['unit_type']}"] += 1
                    else:
                        stats[f"still empty {source['unit_type']}"] += 1
            if changed:
                row["token_length"] = len(tokenizer(format_premise(row["sources"]), row["claim"], add_special_tokens=True, truncation=False)["input_ids"])
                stats["rows changed"] += 1
            stats["rows with an empty source"] += any(not s["text"].strip() for s in row["sources"])
        path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")

    missing = args.parts[0].with_name(args.parts[0].name.split(".part")[0] + ".missing.jsonl")
    with missing.open("w", encoding="utf-8") as handle:
        for (source_id, citation), why in sorted(failed.items()):
            handle.write(json.dumps({"source_id": source_id, "citation": citation, "reason": why, "detail": details[(source_id, citation)]}, ensure_ascii=False) + "\n")
    for key, value in sorted(stats.items()):
        print(f"{key}: {value}")
    print(f"{len(failed)} sources still empty, listed in {missing}")


if __name__ == "__main__":
    main()
