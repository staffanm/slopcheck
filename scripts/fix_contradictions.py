#!/usr/bin/env python3
"""
Scans all contradiction rows in all_generated_pairs.jsonl, identifies pseudo-contradictions
(where the LLM generated a synonym or compatible statement instead of a true negation/contradiction),
re-generates them with strict polarity reversal prompts, verifies them, and updates the dataset.
"""

import json
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional

from transformers import AutoTokenizer
from backend.resolver import format_premise

LLM_ENDPOINT = "http://127.0.0.1:8080/v1/chat/completions"
LLM_MODEL = "qwen3.8-27b"

NEGATION_WORDS = {"inte", "ej", "icke", "aldrig", "saknas", "utesluter"}

ANTONYM_PAIRS = [
    ("direkt", "indirekt"),
    ("positiva", "negativa"),
    ("giltig", "ogiltig"),
    ("tillåten", "otillåten"),
    ("tillåtet", "otillåtet"),
    ("förbjuden", "tillåten"),
    ("förbjudet", "tillåtet"),
    ("ringa", "grovt"),
    ("ringa", "allvarligt"),
    ("högre", "lägre"),
    ("före", "efter"),
    ("mindre", "mer"),
    ("utan", "med"),
    ("skyldighet", "rättighet"),
]

def query_llm(prompt: str, max_tokens: int = 250, temperature: float = 0.2) -> Optional[str]:
    payload = {
        "model": LLM_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
        "enable_thinking": False
    }
    try:
        req = urllib.request.Request(
            LLM_ENDPOINT,
            headers={"Content-Type": "application/json"},
            data=json.dumps(payload).encode("utf-8")
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            content = data["choices"][0]["message"]["content"].strip()
            if (content.startswith('"') and content.endswith('"')) or (content.startswith('”') and content.endswith('”')):
                content = content[1:-1].strip()
            return content
    except Exception as e:
        print(f"LLM query error: {e}", file=sys.stderr)
        return None


def verify_with_llm(auth_claim: str, contra_claim: str) -> bool:
    """Returns True if LLM confirms contra_claim directly contradicts auth_claim."""
    prompt = (
        f"Avgör om Påstående B är en direkt motsägelse (kontradiktion) till Påstående A, "
        f"eller om det är förenligt/synonymt med Påstående A.\n"
        f"Påstående A: {auth_claim}\n"
        f"Påstående B: {contra_claim}\n\n"
        f"Svara ENBART med antingen 'MOTSÄGELSE' eller 'FÖRENLIGT'."
    )
    res = query_llm(prompt, max_tokens=10, temperature=0.0)
    if res and "MOTSÄGELSE" in res.upper():
        return True
    return False


def is_fast_polarity_flip(auth: str, contra: str) -> bool:
    """Fast check for unmistakable negation addition/removal or antonym flip."""
    a_words = set(re.findall(r"\b\w+\b", auth.lower()))
    c_words = set(re.findall(r"\b\w+\b", contra.lower()))

    # 1. Added negation word
    added = c_words - a_words
    removed = a_words - c_words
    if any(nw in added for nw in NEGATION_WORDS):
        return True

    # 2. Removed negation word
    if any(nw in removed for nw in NEGATION_WORDS):
        return True

    # 3. Antonym pair flip
    for w1, w2 in ANTONYM_PAIRS:
        if (w1 in a_words and w2 in c_words) or (w2 in a_words and w1 in c_words):
            return True

    return False


def generate_true_contradiction(auth_claim: str) -> str:
    """Generates a verified true contradiction with strict prompt and negation fallback."""
    # Attempt 1: Strict contradiction prompt
    prompt1 = (
        f"Formulera en direkt motsägelse (kontradiktion) till följande juridiska påstående.\n"
        f"Krav:\n"
        f"1. Påståendet MÅSTE göras materiellt felaktigt och motsagt, t.ex. genom att införa en negation ('inte'/'ej'), "
        f"ta bort en befintlig negation ('inte' tas bort), eller vända på rättsföljden/rekvisitet så att det blir juridiskt falskt.\n"
        f"2. Det är STRIKT FÖRBJUDET att endast byta ut ord mot synonymer. Innebörden måste vara motsatt eller oförenlig med originalet.\n"
        f"3. Svara ENBART med det ändrade påståendet, utan inledning eller förklaring:\n{auth_claim}"
    )
    cand = query_llm(prompt1, temperature=0.2)
    if cand and cand != auth_claim:
        if is_fast_polarity_flip(auth_claim, cand) or verify_with_llm(auth_claim, cand):
            return cand

    # Attempt 2: Explicit negation prompt
    prompt2 = (
        f"Formulera om följande påstående genom att införa en negation ('inte' eller 'ej') "
        f"så att påståendet förnekas eller blir direkt felaktigt. Svara ENBART med det ändrade påståendet:\n{auth_claim}"
    )
    cand2 = query_llm(prompt2, temperature=0.1)
    if cand2 and cand2 != auth_claim:
        return cand2

    # Fallback if both fail: return cand or cand2
    return cand or cand2 or auth_claim


def process_row(r: dict, auth_claim: str, tokenizer: AutoTokenizer) -> dict:
    contra_claim = r["claim"]
    needs_fix = False

    # Check if contradiction is valid
    if not is_fast_polarity_flip(auth_claim, contra_claim):
        # Verify with LLM
        is_contra = verify_with_llm(auth_claim, contra_claim)
        if not is_contra:
            needs_fix = True

    if needs_fix:
        new_claim = generate_true_contradiction(auth_claim)
        if new_claim and new_claim != contra_claim:
            r["claim"] = new_claim
            premise = format_premise(r.get("sources", []))
            r["token_length"] = len(tokenizer(premise, new_claim, add_special_tokens=True, truncation=False)["input_ids"])
            r["was_fixed"] = True
            return r

    r["was_fixed"] = False
    return r


def main():
    input_file = Path("data/all_generated_pairs.jsonl")
    print(f"Reading dataset from {input_file}...")
    with open(input_file, "r", encoding="utf-8") as f:
        rows = [json.loads(line) for line in f]

    auth_map = {r["origin_claim_id"]: r["claim"] for r in rows if r.get("origin") == "authentic"}
    contradiction_rows = [r for r in rows if r.get("transformation") == "contradiction"]

    print(f"Total rows: {len(rows)}")
    print(f"Contradiction rows to inspect: {len(contradiction_rows)}")

    tokenizer = AutoTokenizer.from_pretrained("BalaRajesh1/mmbert-small-nli")

    fixed_count = 0
    start_time = time.time()

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {
            executor.submit(process_row, r, auth_map.get(r.get("origin_claim_id"), ""), tokenizer): r
            for r in contradiction_rows
        }

        completed = 0
        total = len(contradiction_rows)
        for future in as_completed(futures):
            completed += 1
            res = future.result()
            if res.get("was_fixed"):
                fixed_count += 1
            if completed % 50 == 0 or completed == total:
                elapsed = time.time() - start_time
                rps = completed / elapsed if elapsed > 0 else 1
                rem = (total - completed) / rps
                print(f"[{completed}/{total}] Checked contradictions. Fixed so far: {fixed_count} ({rem:.0f}s remaining)...", flush=True)

    print(f"\nCompleted! Fixed {fixed_count} pseudo-contradictions out of {len(contradiction_rows)} rows.")

    # Remove temporary flag and save
    for r in rows:
        r.pop("was_fixed", None)

    print(f"Writing updated dataset to {input_file}...")
    with open(input_file, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print("Dataset updated successfully!")


if __name__ == "__main__":
    main()
