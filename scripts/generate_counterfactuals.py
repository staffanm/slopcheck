#!/usr/bin/env python3
"""
Generates counterfactual training pairs from authentic supported pairs using local LLM and adjacent units.
"""

import argparse
import hashlib
import json
import os
import random
import re
import sys
import time
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Optional

from transformers import AutoTokenizer

from backend.resolver import CitedUnitResolver, format_premise

LLM_ENDPOINT = "http://127.0.0.1:8080/v1/chat/completions"
LLM_MODEL = "qwen3.8-27b"

def query_llm(prompt: str, max_tokens: int = 250, temperature: float = 0.3) -> Optional[str]:
    """Queries local ninfer LLM with thinking disabled for fast generation."""
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
            # Strip surrounding quotes if model outputs them
            if (content.startswith('"') and content.endswith('"')) or (content.startswith('”') and content.endswith('”')):
                content = content[1:-1].strip()
            return content
    except Exception as e:
        print(f"LLM query error: {e}", file=sys.stderr)
        return None


def generate_paraphrase(claim: str) -> Optional[str]:
    prompt = (
        "Formulera om följande juridiska påstående på svenska så att den juridiska innebörden bevaras exakt "
        "(t.ex. genom synonymbyte, ändrad ordföljd eller omformulering). Svara ENBART med det omformulerade påståendet, "
        f"utan citattecken, inledning eller förklaringar:\n{claim}"
    )
    return query_llm(prompt, temperature=0.3)


def generate_contradiction(claim: str) -> Optional[str]:
    prompt = (
        "Ändra ett väsentligt led i följande juridiska påstående så att det blir direkt felaktigt eller motsagt "
        "(t.ex. ändra utfall eller regel, invertera med negation, eller ändra en tidsfrist/belopp/villkor). "
        "Påståendet ska fortfarande vara helt naturligt och auktoritativt skrivet på svenska. Svara ENBART med det ändrade påståendet, "
        f"utan citattecken, inledning eller förklaringar:\n{claim}"
    )
    return query_llm(prompt, temperature=0.4)


def generate_overstatement(claim: str) -> Optional[str]:
    prompt = (
        "Gör följande juridiska påstående mer långtgående eller missvisande genom att överdriva regeln "
        "(t.ex. ta bort ett förbehåll eller undantag, ändra från diskretion/möjlighet 'får/kan' till ovillkorligt krav 'ska/måste', "
        "eller ta bort 'i regel'/'som huvudregel'). Påståendet ska fortfarande vara grammatiskt korrekt och naturligt på svenska. "
        f"Svara ENBART med det ändrade påståendet, utan citattecken, inledning eller förklaringar:\n{claim}"
    )
    return query_llm(prompt, temperature=0.3)


def find_adjacent_source(source: dict, resolver: CitedUnitResolver, all_sources: list[dict]) -> Optional[dict]:
    """Finds an adjacent unit (paragraph, stycke, page) or related authority."""
    s_id = source["source_id"]
    u_type = source["unit_type"]
    cand_uri = None

    # 1. Case pinpoint or CJEU pinpoint
    if u_type in ["case_pinpoint", "cjeu_pinpoint"]:
        m = re.search(r"#p(\d+)", s_id)
        if m:
            p_num = int(m.group(1))
            cand_p = p_num + 1 if p_num > 1 else 2
            cand_uri = s_id.split("#")[0] + f"#p{cand_p}"

    # 2. Prop page
    elif u_type == "prop_page":
        m = re.search(r"#sid(\d+)", s_id)
        if m:
            sid = int(m.group(1))
            cand_sid = sid + 1
            cand_uri = s_id.split("#")[0] + f"#sid{cand_sid}"

    # 3. Statute provision
    elif u_type in ["statute_provision", "statute_stycke"]:
        m = re.search(r"#.*P(\d+)", s_id)
        if m:
            p_num = int(m.group(1))
            cand_p = p_num + 1
            base = s_id.split("#")[0]
            cand_uri = f"{base}#P{cand_p}"

    if cand_uri:
        full_uri = f"https://lagen.nu/{cand_uri}" if not cand_uri.startswith("http") else cand_uri
        res = resolver.resolve(full_uri)
        if res.get("status") == "ok" and res.get("text"):
            return {
                "citation": f"{source['citation']} (intilliggande)",
                "source_id": res.get("source_id", cand_uri).replace("https://lagen.nu/", ""),
                "document_id": res.get("document_id", cand_uri.split("#")[0]).replace("https://lagen.nu/", ""),
                "unit_type": res.get("unit_type", u_type),
                "text": res["text"].strip(),
                "negative_type": "adjacent"
            }

    # 4. Fallback: pick another source of same unit type from corpus
    matching_types = [s for s in all_sources if s.get("unit_type") == u_type and s.get("source_id") != s_id]
    if matching_types:
        chosen = random.choice(matching_types)
        return {
            "citation": chosen["citation"],
            "source_id": chosen["source_id"],
            "document_id": chosen["document_id"],
            "unit_type": chosen["unit_type"],
            "text": chosen["text"],
            "negative_type": "topic_match"
        }

    return None


def process_family(auth_row: dict, resolver: CitedUnitResolver, tokenizer: AutoTokenizer, all_sources: list[dict]) -> list[dict]:
    """Generates a complete family of rows for an authentic pair under PRD Section 5."""
    family = []
    claim = auth_row["claim"]
    sources = auth_row.get("sources") or ([auth_row["source"]] if "source" in auth_row else [])
    origin_claim_id = auth_row["origin_claim_id"]
    origin_doc_id = auth_row["origin_document_id"]
    origin_para = auth_row["origin_paragraph"]
    first_src_id = sources[0]["source_id"] if sources else "unknown"

    base_premise = format_premise(sources)

    # 1. Authentic supported row
    family.append(auth_row)

    # 2. Paraphrased supported row (LLM)
    paraphrase_claim = generate_paraphrase(claim)
    if paraphrase_claim and paraphrase_claim != claim:
        pair_len = len(tokenizer(base_premise, paraphrase_claim, add_special_tokens=True, truncation=False)["input_ids"])
        if pair_len <= 8192:
            row_id_hash = hashlib.md5(f"{origin_claim_id}_{first_src_id}_para".encode("utf-8")).hexdigest()[:12]
            family.append({
                "id": f"cf_para_{row_id_hash}",
                "claim": paraphrase_claim,
                "sources": sources,
                "label": "supported",
                "origin_document_id": origin_doc_id,
                "origin_paragraph": origin_para,
                "origin_claim_id": origin_claim_id,
                "origin": "counterfactual",
                "transformation": "paraphrase",
                "token_length": pair_len
            })

    # 3. Same claim + correct sources in another order (supported) - for multi-source rows
    if len(sources) > 1:
        reordered_sources = list(reversed(sources))
        reordered_premise = format_premise(reordered_sources)
        pair_len = len(tokenizer(reordered_premise, claim, add_special_tokens=True, truncation=False)["input_ids"])
        if pair_len <= 8192:
            row_id_hash = hashlib.md5(f"{origin_claim_id}_{first_src_id}_reorder".encode("utf-8")).hexdigest()[:12]
            family.append({
                "id": f"cf_reorder_{row_id_hash}",
                "claim": claim,
                "sources": reordered_sources,
                "label": "supported",
                "origin_document_id": origin_doc_id,
                "origin_paragraph": origin_para,
                "origin_claim_id": origin_claim_id,
                "origin": "counterfactual",
                "transformation": "reordered_sources",
                "token_length": pair_len
            })

    # 4. Same claim + correct sources + 1 irrelevant distractor unit (supported)
    existing_src_ids = {s["source_id"] for s in sources}
    distractor_cands = [s for s in all_sources if s["source_id"] not in existing_src_ids and s.get("document_id") != origin_doc_id]
    if distractor_cands:
        distractor = dict(random.choice(distractor_cands))
        distractor_sources = list(sources) + [distractor]
        distractor_premise = format_premise(distractor_sources)
        pair_len = len(tokenizer(distractor_premise, claim, add_special_tokens=True, truncation=False)["input_ids"])
        if pair_len <= 8192:
            row_id_hash = hashlib.md5(f"{origin_claim_id}_{first_src_id}_distract".encode("utf-8")).hexdigest()[:12]
            family.append({
                "id": f"cf_distract_{row_id_hash}",
                "claim": claim,
                "sources": distractor_sources,
                "label": "supported",
                "origin_document_id": origin_doc_id,
                "origin_paragraph": origin_para,
                "origin_claim_id": origin_claim_id,
                "origin": "counterfactual",
                "transformation": "distractor_source",
                "token_length": pair_len
            })

    # 5. Hard negative unsupported row: replace every source with a non-supporting unit
    neg_sources = []
    neg_types = []
    for s in sources:
        neg_s = find_adjacent_source(s, resolver, all_sources)
        if neg_s:
            neg_type = neg_s.pop("negative_type", "adjacent")
            neg_types.append(neg_type)
            neg_sources.append(neg_s)
        else:
            break

    if len(neg_sources) == len(sources):
        neg_premise = format_premise(neg_sources)
        pair_len = len(tokenizer(neg_premise, claim, add_special_tokens=True, truncation=False)["input_ids"])
        if pair_len <= 8192:
            neg_trans = "adjacent" if "adjacent" in neg_types else "topic_match"
            row_id_hash = hashlib.md5(f"{origin_claim_id}_{first_src_id}_unsupp".encode("utf-8")).hexdigest()[:12]
            family.append({
                "id": f"cf_unsupp_{row_id_hash}",
                "claim": claim,
                "sources": neg_sources,
                "label": "unsupported",
                "origin_document_id": origin_doc_id,
                "origin_paragraph": origin_para,
                "origin_claim_id": origin_claim_id,
                "origin": "counterfactual",
                "transformation": neg_trans,
                "token_length": pair_len
            })

    # 6. Contradiction incorrect row (LLM)
    contra_claim = generate_contradiction(claim)
    if contra_claim and contra_claim != claim:
        pair_len = len(tokenizer(base_premise, contra_claim, add_special_tokens=True, truncation=False)["input_ids"])
        if pair_len <= 8192:
            row_id_hash = hashlib.md5(f"{origin_claim_id}_{first_src_id}_contra".encode("utf-8")).hexdigest()[:12]
            family.append({
                "id": f"cf_incorr_{row_id_hash}",
                "claim": contra_claim,
                "sources": sources,
                "label": "incorrect",
                "origin_document_id": origin_doc_id,
                "origin_paragraph": origin_para,
                "origin_claim_id": origin_claim_id,
                "origin": "counterfactual",
                "transformation": "contradiction",
                "token_length": pair_len
            })

    # 7. Overstatement misleading row (LLM)
    over_claim = generate_overstatement(claim)
    if over_claim and over_claim != claim:
        pair_len = len(tokenizer(base_premise, over_claim, add_special_tokens=True, truncation=False)["input_ids"])
        if pair_len <= 8192:
            row_id_hash = hashlib.md5(f"{origin_claim_id}_{first_src_id}_over".encode("utf-8")).hexdigest()[:12]
            family.append({
                "id": f"cf_mislead_{row_id_hash}",
                "claim": over_claim,
                "sources": sources,
                "label": "misleading",
                "origin_document_id": origin_doc_id,
                "origin_paragraph": origin_para,
                "origin_claim_id": origin_claim_id,
                "origin": "counterfactual",
                "transformation": "overstatement",
                "token_length": pair_len
            })

    return family


def main():
    parser = argparse.ArgumentParser(description="Generate counterfactual dataset using local LLM.")
    parser.add_argument("--input", type=str, default="data/authentic_pairs.jsonl")
    parser.add_argument("--output", type=str, default="data/all_generated_pairs.jsonl")
    parser.add_argument("--workers", type=int, default=4, help="Number of concurrent worker threads")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of authentic pairs to process")
    args = parser.parse_args()

    input_file = Path(args.input)
    output_file = Path(args.output)

    print(f"Reading authentic pairs from {input_file}...")
    with open(input_file, "r", encoding="utf-8") as f:
        auth_rows = [json.loads(line) for line in f]

    if args.limit:
        auth_rows = auth_rows[:args.limit]

    print(f"Loaded {len(auth_rows)} authentic rows.")

    tokenizer = AutoTokenizer.from_pretrained("BalaRajesh1/mmbert-small-nli")
    resolver = CitedUnitResolver()
    all_sources = [s for r in auth_rows for s in (r.get("sources") or ([r["source"]] if "source" in r else []))]

    all_rows = []
    total = len(auth_rows)
    start_time = time.time()

    print(f"Starting counterfactual generation across {args.workers} workers...")
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_to_row = {
            executor.submit(process_family, row, resolver, tokenizer, all_sources): row
            for row in auth_rows
        }

        completed = 0
        for future in as_completed(future_to_row):
            completed += 1
            try:
                family_rows = future.result()
                all_rows.extend(family_rows)
            except Exception as e:
                print(f"Error processing row: {e}", file=sys.stderr)

            if completed % 25 == 0 or completed == total:
                elapsed = time.time() - start_time
                rps = completed / elapsed
                remaining = (total - completed) / rps if rps > 0 else 0
                print(f"[{completed}/{total}] Generated {len(all_rows)} total rows ({completed/total*100:.1f}%) - {remaining:.0f}s remaining...")

    # Write output JSONL
    print(f"\nWriting {len(all_rows)} total rows to {output_file}...")
    with open(output_file, "w", encoding="utf-8") as f:
        for row in all_rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    # Summary statistics
    label_counts = Counter(r["label"] for r in all_rows)
    origin_counts = Counter(r["origin"] for r in all_rows)
    trans_counts = Counter(r["transformation"] for r in all_rows)

    print("\n--- Generation Summary ---")
    print(f"Total rows: {len(all_rows)}")
    print("\nBy Label:")
    for lbl, count in label_counts.most_common():
        print(f"  {lbl}: {count} ({count/len(all_rows)*100:.1f}%)")
    print("\nBy Origin:")
    for orig, count in origin_counts.most_common():
        print(f"  {orig}: {count}")
    print("\nBy Transformation:")
    for trans, count in trans_counts.most_common():
        print(f"  {trans}: {count}")

if __name__ == "__main__":
    main()
