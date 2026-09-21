#!/usr/bin/env python3
"""
Extracts authentic training pairs from ferenda dom artifacts according to Section 4.2 v1 Se-rules.
"""

import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Optional

import brotli
from transformers import AutoTokenizer

from backend.resolver import CitedUnitResolver, extract_node_text

# Common Swedish abbreviations to protect against premature sentence splitting
SWEDISH_ABBREVS = [
    r"t\.ex\.", r"bl\.a\.", r"dvs\.", r"d\.v\.s\.", r"t\.o\.m\.", r"fr\.o\.m\.",
    r"st\.", r"kap\.", r"prop\.", r"bet\.", r"mot\.", r"p\.", r"punkten\.", r"nr\.",
    r"s\.", r"ff\.", r"m\.fl\.", r"avs\.", r"a\.a\.", r"a\.prop\.", r"a\.st\.",
    r"NJA\.", r"RH\.", r"HFD\.", r"RÅ\.", r"AD\.", r"MD\.", r"MÖD\.", r"MIG\.",
    r"f\.d\.", r"ord\.", r"reg\.", r"dir\.", r"skr\."
]
ABBREV_PATTERN = re.compile(r"\b(" + "|".join(SWEDISH_ABBREVS) + r")", re.IGNORECASE)

def split_sentences(text: str) -> list[str]:
    """Splits Swedish legal text into sentences avoiding common abbreviations."""
    # Replace dots in abbreviations with placeholder
    def replace_abbrev(match):
        return match.group(0).replace(".", "<DOT>")

    protected = ABBREV_PATTERN.sub(replace_abbrev, text)
    # Split on sentence terminals followed by whitespace and capital letter
    raw_sents = re.split(r"(?<=[.!?])\s+(?=[A-ZÅÄÖ])", protected)
    result = []
    for s in raw_sents:
        cleaned = s.replace("<DOT>", ".").strip()
        if cleaned:
            result.append(cleaned)
    return result


def is_clean_claim(claim: str) -> bool:
    """Ensures a claim is a complete, self-contained Swedish legal statement."""
    if not claim or len(claim) < 35:
        return False
    # Must start with capital letter or section/chapter number
    if not re.match(r"^[0-9A-ZÅÄÖ]", claim):
        return False
    # Reject raw PDF/OCR headers and court docket labels
    if re.search(r"\b(sid\s*\d+|slutligt beslut|tingsrätt|hovrätt|mål\s*nr|aktbil|protokoll)\b", claim, re.IGNORECASE):
        return False
    # Reject claims containing internal citation parentheticals (multiple citations in paragraph)
    if re.search(r"\((?:se|jfr)\b", claim, re.IGNORECASE):
        return False
    # Must have at least 6 words
    if len(claim.split()) < 6:
        return False
    # Reject claims ending in dangling conjunctions or prepositions
    if re.search(r"\b(och|eller|att|som|om|av|på|i|för|med)\s*$", claim, re.IGNORECASE):
        return False
    return True


def extract_named_cases_from_text(text: str) -> list[dict]:
    """Finds unlinked named cases in quotes in text, e.g. ”Brevinkastet” p. 37."""
    from backend.resolver import NAMED_CASES
    results = []
    matches = list(re.finditer(r'[”\"«]([^”\"»]+)[”\"»]', text))
    for m in matches:
        candidate = m.group(1).strip().lower()
        if candidate in NAMED_CASES:
            after_text = text[m.end():]
            p_m = re.match(r'^\s*(p(?:unkt(?:erna)?)?\.?\s*\d+(?:\s*(?:och|–|-)\s*\d+)?)', after_text, re.IGNORECASE)
            pinpoint = p_m.group(1).strip() if p_m else ''
            full_span_end = m.end() + (p_m.end() if p_m else 0)
            results.append({
                'name': m.group(1).strip(),
                'clean_name': candidate,
                'pinpoint': pinpoint,
                'span': (m.start(), full_span_end),
                'base_uri': NAMED_CASES[candidate]
            })
    return results


def expand_citation(ref_text: str, target_uri: str, follower: str = "") -> str:
    """Expands fragmented citations (e.g. '41' -> 'prop. 2005/06:35 s. 41') and cleans trailing conjunctions."""
    cit = f"{ref_text} {follower}".strip() if follower else ref_text
    cit = re.sub(r"\s+(?:och|samt|jfr)\s*$", "", cit, flags=re.IGNORECASE).strip()
    cit = re.sub(r"[.,;]+$", "", cit).strip()
    if re.match(r"^\d+(\s+f{1,2}\.?)?$", cit):
        m = re.search(r"prop/(\d{4})/(\d+):(\d+)#sid(\d+)", target_uri)
        if m:
            cit = f"prop. {m.group(1)}/{m.group(2)}:{m.group(3)} s. {cit}"
    return cit


def extract_claim_and_citations(stycke_node: dict) -> Optional[dict]:
    """
    Evaluates Section 4.2 PRD rules for an AST stycke node:
    - exactly one citation parenthetical, introduced strictly by Se
    - contains one or more references
    - trailing at the end of the paragraph
    - at most 3 sentences before parenthetical
    - clean, complete legal proposition
    """
    text_items = stycke_node.get("text", [])
    if not isinstance(text_items, list):
        return None

    full_text = ""
    item_offsets = []
    for it in text_items:
        start = len(full_text)
        t = it if isinstance(it, str) else it.get("text", "")
        full_text += t
        item_offsets.append((start, len(full_text), it))

    matches = list(re.finditer(r"\(([^)]+)\)", full_text))
    if not matches:
        return None

    last_m = matches[-1]
    after = full_text[last_m.end():].strip()
    if after and after != ".":
        return None

    inside = last_m.group(1).strip()
    intro_m = re.match(r"^[Ss]e\s+(.*)$", inside)
    if not intro_m:
        return None

    content = intro_m.group(1).strip()
    # Reject weak introducers
    if re.match(r"^(även|dock|t\.ex\.|bl\.a\.|härtill)\b", content, re.IGNORECASE):
        return None

    # Check for multiple citation parentheticals in paragraph
    for m in matches[:-1]:
        m_in = m.group(1).strip()
        if re.match(r"^(?:[Ss]e|[Jj]fr)\b", m_in):
            return None

    # Check for mix of Se and Jfr inside parenthetical
    if re.search(r"\bjfr\b", inside, re.IGNORECASE):
        return None

    paren_start = last_m.start()
    paren_end = last_m.end()

    paren_items = []
    claim_items = []
    for start, end, it in item_offsets:
        if end <= paren_start:
            claim_items.append(it)
        elif start >= paren_start and end <= paren_end:
            paren_items.append(it)
        elif start < paren_start and end > paren_start:
            prefix_len = paren_start - start
            claim_t = (it if isinstance(it, str) else it.get("text", ""))[:prefix_len]
            claim_items.append(claim_t)
            inside_t = (it if isinstance(it, str) else it.get("text", ""))[prefix_len:]
            paren_items.append(inside_t)

    claim_raw = "".join(it if isinstance(it, str) else it.get("text", "") for it in claim_items).strip()
    claim = re.sub(r"^\s*\d+\.?\s*", "", claim_raw).strip()

    if not is_clean_claim(claim):
        return None
    if claim.startswith(('"', '”', '»', '›', "'", "”", "„")):
        return None
    if re.search(r"\b(anförde|uttalade|yttrade|angav|stadgade|konstaterade)\s*:\s*$", claim, re.IGNORECASE):
        return None

    # Allow at most 3 sentences before parenthetical
    sents = split_sentences(claim)
    if not (1 <= len(sents) <= 3):
        return None

    ref_sources = []
    dict_indices = [i for i, it in enumerate(paren_items) if isinstance(it, dict) and "uri" in it]

    for idx, d_idx in enumerate(dict_indices):
        ref = paren_items[d_idx]
        next_d_idx = dict_indices[idx + 1] if idx + 1 < len(dict_indices) else len(paren_items)

        follower_parts = []
        for it in paren_items[d_idx + 1 : next_d_idx]:
            follower_parts.append(it if isinstance(it, str) else it.get("text", ""))
        follower_raw = "".join(follower_parts)

        # Check for unlinked named cases in follower text
        named_cases = extract_named_cases_from_text(follower_raw)
        if named_cases:
            first_nc = named_cases[0]
            follower_for_this = follower_raw[:first_nc["span"][0]].strip()
        else:
            follower_for_this = follower_raw.strip()

        if ")" in follower_for_this:
            follower_for_this = follower_for_this[:follower_for_this.index(")")].strip()
        follower_for_this = re.sub(r"(?:,\s*|\s+och\s+|\s+samt\s+)$", "", follower_for_this).strip()

        ref_text = ref.get("text", "").strip()
        ref_uri = ref.get("uri", "").strip()
        target_uri = ref_uri

        if "dom/" in ref_uri and "#" not in ref_uri:
            p_match = re.search(r"p(?:unkt(?:erna)?)?\.?\s*(\d+)(?:\s*(?:och|–|-)\s*(\d+))?", follower_for_this, re.IGNORECASE)
            if p_match:
                start_p = p_match.group(1)
                end_p = p_match.group(2)
                frag = f"p{start_p}" + (f"-{end_p}" if end_p else "")
                target_uri = f"{ref_uri}#{frag}"

        full_cit = expand_citation(ref_text, target_uri, follower_for_this)
        ref_sources.append({"citation": full_cit, "target_uri": target_uri})

        # Add detected named cases as sources
        for nc in named_cases:
            base_uri = nc["base_uri"]
            nc_pinpoint = nc["pinpoint"]
            nc_uri = base_uri
            if nc_pinpoint:
                p_m = re.search(r"(\d+)", nc_pinpoint)
                if p_m:
                    nc_uri = f"{base_uri}#p{p_m.group(1)}"
            nc_cit = f"”{nc['name']}” {nc_pinpoint}".strip()
            ref_sources.append({"citation": nc_cit, "target_uri": nc_uri})

    # A popular name right before its NJA citation ("Smitningen" NJA 2018 s. 394 p. 9)
    # is a label for that citation, not a second whole-judgment source.
    linked_documents = {src["target_uri"].split("#")[0] for src in ref_sources if not src["citation"].startswith("”")}
    ref_sources = [src for src in ref_sources
                   if not (src["citation"].startswith("”") and "#" not in src["target_uri"] and src["target_uri"] in linked_documents)]

    # ECHR citations ("Allan v. the United Kingdom, no. 48539/99, § 44") are not
    # linked by lagen.nu's citation parser and are therefore missing here. That
    # linking belongs in ferenda, not in this extractor.

    if not ref_sources:
        return None

    return {
        "claim": claim,
        "ref_sources": ref_sources,
    }


def find_deciding_instans_domskal(doc: dict, court_slug: str) -> list[dict]:
    """Finds stycken strictly in the domskal of the deciding court instans."""
    court_name = doc.get("court_namn")
    structure = doc.get("structure", [])

    deciding = None
    instans_nodes = []
    for n in structure:
        if isinstance(n, dict) and n.get("type") == "instans":
            instans_nodes.append(n)
            if court_name and n.get("court") == court_name:
                deciding = n
            elif court_slug in ["nja", "hd", "hdo"] and n.get("court") in ["Högsta domstolen", "HD"]:
                deciding = n
            elif court_slug in ["hfd", "rå"] and n.get("court") in ["Högsta förvaltningsdomstolen", "Regeringsrätten"]:
                deciding = n
            elif court_slug in ["ad"] and n.get("court") in ["Arbetsdomstolen", "AD"]:
                deciding = n
            elif court_slug in ["md"] and n.get("court") in ["Marknadsdomstolen", "MD"]:
                deciding = n
            elif court_slug in ["möd", "mmod"] and n.get("court") in ["Miljööverdomstolen", "Mark- och miljööverdomstolen", "MÖD", "MMÖD"]:
                deciding = n
            elif court_slug in ["pmöd"] and n.get("court") in ["Patent- och marknadsöverdomstolen", "PMÖD"]:
                deciding = n
            elif court_slug in ["mig"] and n.get("court") in ["Migrationsöverdomstolen", "MIG"]:
                deciding = n

    # Fallback to the last instans in the file if specific court name wasn't set on node
    if not deciding and instans_nodes:
        deciding = instans_nodes[-1]

    roots = deciding.get("children", []) if deciding else structure

    # Strictly find explicit domskal nodes
    domskal_nodes = []
    def search_domskal(node):
        if isinstance(node, dict):
            if node.get("type") == "domskal":
                domskal_nodes.append(node)
            elif node.get("type") not in ["instans", "betankande"]:
                for c in node.get("children", []):
                    search_domskal(c)
        elif isinstance(node, list):
            for it in node:
                search_domskal(it)

    search_domskal(roots)

    # If no explicit domskal node, return empty list to prevent uncurated OCR/PDF bleed
    if not domskal_nodes:
        return []

    stycken = []
    for d in domskal_nodes:
        for c in d.get("children", []):
            if isinstance(c, dict) and c.get("type") == "stycke":
                stycken.append(c)

    return stycken


def main():
    parser = argparse.ArgumentParser(description="Extract authentic training pairs from dom artifacts.")
    parser.add_argument("--dom-dir", type=str, default="/home/staffan/repos/ferenda/site/data/artifact/dom")
    parser.add_argument("--output", type=str, default="data/authentic_pairs.jsonl")
    parser.add_argument("--max-files", type=int, default=None, help="Limit files scanned for testing")
    parser.add_argument("--model-name", type=str, default="BalaRajesh1/mmbert-small-nli")
    args = parser.parse_args()

    dom_dir = Path(args.dom_dir)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"Loading tokenizer {args.model_name}...")
    tokenizer = AutoTokenizer.from_pretrained(args.model_name)
    resolver = CitedUnitResolver()

    dom_files = sorted(list(dom_dir.glob("*.json.br")))
    if args.max_files:
        dom_files = dom_files[:args.max_files]

    print(f"Scanning {len(dom_files)} dom files...")

    total_files = len(dom_files)
    extracted_rows = []
    court_counter = Counter()
    unit_type_counter = Counter()
    length_buckets = Counter()
    source_count_counter = Counter()

    for idx, fpath in enumerate(dom_files):
        if (idx + 1) % 1000 == 0 or idx + 1 == total_files:
            print(f"[{idx+1}/{total_files}] Extracted {len(extracted_rows)} authentic pairs...")

        court_slug = fpath.name.split("_")[0].lower()
        try:
            with open(fpath, "rb") as f:
                doc = json.loads(brotli.decompress(f.read()).decode("utf-8"))
        except Exception:
            continue

        doc_uri = doc.get("uri", "").rstrip("/")
        if not doc_uri:
            continue

        doc_id = doc_uri.replace("https://lagen.nu/", "")
        stycken = find_deciding_instans_domskal(doc, court_slug)

        for s_idx, s in enumerate(stycken):
            extracted = extract_claim_and_citations(s)
            if not extracted:
                continue

            claim = extracted["claim"]
            ref_sources = extracted["ref_sources"]

            # Resolve all cited sources
            all_resolved = True
            resolved_sources = []
            for r_info in ref_sources:
                target_uri = r_info["target_uri"]
                citation = r_info["citation"]
                clean_target = target_uri.split("#")[0].rstrip("/")

                # Self-citation check: source document cannot be origin document
                if clean_target == doc_uri:
                    all_resolved = False
                    break

                res = resolver.resolve(target_uri, citation=citation)
                if res.get("status") != "ok" or not res.get("text"):
                    all_resolved = False
                    break

                source_text = res["text"].strip()
                unit_type = res.get("unit_type", "unknown")
                source_id = res.get("source_id", target_uri).replace("https://lagen.nu/", "")
                source_doc_id = res.get("document_id", clean_target).replace("https://lagen.nu/", "")
                resolved_sources.append({
                    "citation": citation,
                    "source_id": source_id,
                    "document_id": source_doc_id,
                    "unit_type": unit_type,
                    "text": source_text
                })

            if not all_resolved or not resolved_sources:
                continue

            # Format premise with headers as required by PRD Section 7
            from backend.resolver import format_premise
            premise = format_premise(resolved_sources)

            # Tokenize pair [premise=sources, hypothesis=claim]
            pair_encoding = tokenizer(
                premise,
                claim,
                add_special_tokens=True,
                truncation=False,
                return_attention_mask=False
            )
            token_len = len(pair_encoding["input_ids"])

            # Strict 8192 token budget: no truncation
            if token_len > 8192:
                continue

            # Paragraph ordinal or index
            ordinal = s.get("ordinal") or f"p{s_idx + 1}"
            origin_claim_id = f"{doc_id}#{ordinal}"

            first_src_id = resolved_sources[0]["source_id"]
            row_id_hash = hashlib.md5(f"{origin_claim_id}_{first_src_id}_{len(resolved_sources)}".encode("utf-8")).hexdigest()[:12]
            row_id = f"auth_{row_id_hash}"

            row = {
                "id": row_id,
                "claim": claim,
                "actual_text": extract_node_text(s),
                "sources": resolved_sources,
                "label": "supported",
                "origin_document_id": doc_id,
                "origin_paragraph": str(ordinal),
                "origin_claim_id": origin_claim_id,
                "origin": "authentic",
                "transformation": None,
                "token_length": token_len
            }

            extracted_rows.append(row)
            court_counter[court_slug] += 1
            for src in resolved_sources:
                unit_type_counter[src["unit_type"]] += 1
            source_count_counter[len(resolved_sources)] += 1

            if token_len <= 512:
                length_buckets["<=512"] += 1
            elif token_len <= 2048:
                length_buckets["513-2048"] += 1
            elif token_len <= 4096:
                length_buckets["2049-4096"] += 1
            else:
                length_buckets["4097-8192"] += 1

    # Write output JSONL
    print(f"\nWriting {len(extracted_rows)} authentic pairs to {output_path}...")
    with open(output_path, "w", encoding="utf-8") as f:
        for row in extracted_rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    print("\n--- Extraction Summary ---")
    print(f"Total authentic pairs: {len(extracted_rows)}")
    print("\nBy Source Count per Claim:")
    for sc, count in sorted(source_count_counter.items()):
        print(f"  {sc} {'källa' if sc == 1 else 'källor'}: {count} ({count/max(len(extracted_rows), 1)*100:.1f}%)")
    print("\nBy Court:")
    for court, count in court_counter.most_common():
        print(f"  {court.upper()}: {count}")
    print("\nBy Unit Type:")
    for ut, count in unit_type_counter.most_common():
        print(f"  {ut}: {count}")
    print("\nBy Token Length:")
    for bucket in ["<=512", "513-2048", "2049-4096", "4097-8192"]:
        print(f"  {bucket}: {length_buckets.get(bucket, 0)} ({length_buckets.get(bucket, 0)/max(len(extracted_rows), 1)*100:.1f}%)")


if __name__ == "__main__":
    main()
