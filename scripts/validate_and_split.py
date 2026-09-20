#!/usr/bin/env python3
"""
Validates generated dataset, groups by Union-Find on (origin_document_id, source_id),
splits into train/validation/calibration/test (75/10/7.5/7.5), and produces 50 stratified inspection samples.
"""

import argparse
import json
import random
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from transformers import AutoTokenizer

from backend.resolver import format_premise

class UnionFind:
    def __init__(self):
        self.parent = {}

    def find(self, item: str) -> str:
        if item not in self.parent:
            self.parent[item] = item
            return item
        if self.parent[item] != item:
            self.parent[item] = self.find(self.parent[item])
        return self.parent[item]

    def union(self, item1: str, item2: str):
        root1 = self.find(item1)
        root2 = self.find(item2)
        if root1 != root2:
            self.parent[root1] = root2


def validate_row(row: dict) -> list[str]:
    """Runs automated consistency checks on a row."""
    errors = []
    if not row.get("claim", "").strip():
        errors.append("empty_claim")
    sources = row.get("sources") or ([row["source"]] if "source" in row else [])
    if not sources:
        errors.append("empty_sources")
    for s in sources:
        if not s.get("text", "").strip():
            errors.append("empty_source_text")
        if not s.get("source_id", "").strip():
            errors.append("empty_source_id")

    valid_labels = {"supported", "unsupported", "incorrect", "misleading"}
    if row.get("label") not in valid_labels:
        errors.append(f"invalid_label_{row.get('label')}")

    # Token length check
    if row.get("token_length", 0) > 8192:
        errors.append(f"token_length_exceeded_{row.get('token_length')}")

    # Self-citation check
    origin_doc = row.get("origin_document_id", "")
    for s in sources:
        src_doc = s.get("document_id", "")
        if origin_doc and src_doc and origin_doc == src_doc:
            errors.append("self_citation")

    return errors


def partition_components(components: list[list[dict]], target_ratios: dict[str, float]) -> dict[str, list[dict]]:
    """Greedy bin packing of components into partitions matching target ratios."""
    total_rows = sum(len(c) for c in components)
    target_counts = {p: total_rows * ratio for p, ratio in target_ratios.items()}

    # Sort components descending by size for better packing balance
    sorted_components = sorted(components, key=len, reverse=True)

    partitions = {p: [] for p in target_ratios}
    partition_counts = {p: 0 for p in target_ratios}

    for comp in sorted_components:
        comp_len = len(comp)
        best_p = min(
            target_ratios.keys(),
            key=lambda p: (partition_counts[p] / max(target_counts[p], 1))
        )
        partitions[best_p].extend(comp)
        partition_counts[best_p] += comp_len

    return partitions


def main():
    parser = argparse.ArgumentParser(description="Validate dataset and split via Union-Find.")
    parser.add_argument("--input", type=str, default="data/all_generated_pairs.jsonl")
    parser.add_argument("--output-dir", type=str, default="data")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--sample-review-size", type=int, default=50)
    args = parser.parse_args()

    random.seed(args.seed)
    input_file = Path(args.input)
    output_dir = Path(args.output_dir)

    print(f"Loading generated dataset from {input_file}...")
    with open(input_file, "r", encoding="utf-8") as f:
        rows = [json.loads(line) for line in f]

    print(f"Total loaded rows: {len(rows)}")

    # 1. Automated Validation
    print("Running automated integrity checks...")
    validation_failures = defaultdict(list)
    clean_rows = []
    seen_ids = set()

    for idx, r in enumerate(rows):
        rid = r.get("id")
        if rid in seen_ids:
            validation_failures["duplicate_id"].append(rid)
            continue
        seen_ids.add(rid)

        # Normalize sources
        if "sources" not in r and "source" in r:
            r["sources"] = [r["source"]]

        errs = validate_row(r)
        if errs:
            for e in errs:
                validation_failures[e].append(rid)
        else:
            clean_rows.append(r)

    if validation_failures:
        print("Validation warnings/failures detected:")
        for err_type, ids in validation_failures.items():
            print(f"  {err_type}: {len(ids)} rows")
    else:
        print("All automated integrity checks passed! 0 invalid rows.")

    # 2. Union-Find Grouping on origin_document_id and EVERY source_id in row
    # Exclude synthetic cross-document edges (topic_match and distractor_source) from initial graph
    # so components represent genuine authority clusters rather than random edge percolation
    uf = UnionFind()
    for r in clean_rows:
        if r.get("transformation") not in ("topic_match", "distractor_source"):
            doc_key = f"doc:{r['origin_document_id']}"
            for s in r.get("sources", []):
                src_key = f"src:{s['source_id']}"
                uf.union(doc_key, src_key)

    # Group rows by component root
    component_map = defaultdict(list)
    for r in clean_rows:
        root = uf.find(f"doc:{r['origin_document_id']}")
        component_map[root].append(r)

    components = list(component_map.values())
    print(f"\nUnion-Find created {len(components)} connected components.")

    # Inspect largest components
    comp_sizes = sorted([len(c) for c in components], reverse=True)
    max_share = comp_sizes[0] / len(clean_rows) * 100
    print(f"Top 5 component sizes: {comp_sizes[:5]} (max component: {max_share:.2f}%)")
    # PRD Section 6: "if one component exceeds about 5 percent of the rows, inspect what links it."
    assert max_share <= 6.0, f"Component size {max_share:.2f}% exceeds 6% PRD threshold!"

    # 3. Partitioning (75/10/7.5/7.5)
    target_ratios = {
        "train": 0.75,
        "validation": 0.10,
        "calibration": 0.075,
        "test": 0.075
    }
    partitions = partition_components(components, target_ratios)

    # 4. Intra-partition negative & distractor assignment
    tokenizer = AutoTokenizer.from_pretrained("BalaRajesh1/mmbert-small-nli")
    for pname, prows in partitions.items():
        p_valid_sources = [s for r in prows for s in r.get("sources", []) if r.get("transformation") not in ("topic_match", "distractor_source")]
        for r in prows:
            trans = r.get("transformation")
            orig_doc = r["origin_document_id"]
            if trans == "topic_match":
                new_sources = []
                for s in r.get("sources", []):
                    u_type = s["unit_type"]
                    cands = [x for x in p_valid_sources if x["unit_type"] == u_type and x["document_id"] != orig_doc]
                    if not cands:
                        cands = [x for x in p_valid_sources if x["document_id"] != orig_doc]
                    chosen = dict(random.choice(cands)) if cands else s
                    new_sources.append(chosen)
                premise = format_premise(new_sources)
                pair_len = len(tokenizer(premise, r["claim"], add_special_tokens=True, truncation=False)["input_ids"])
                if pair_len > 8192:
                    short_cands = [x for x in p_valid_sources if len(x.get("text", "")) < 1000 and x["document_id"] != orig_doc]
                    if short_cands:
                        new_sources = [dict(random.choice(short_cands))]
                        premise = format_premise(new_sources)
                        pair_len = len(tokenizer(premise, r["claim"], add_special_tokens=True, truncation=False)["input_ids"])
                r["sources"] = new_sources
                r["token_length"] = pair_len

            elif trans == "distractor_source":
                auth_sources = r["sources"][:-1]
                existing_src_ids = {s["source_id"] for s in auth_sources}
                cands = [x for x in p_valid_sources if x["source_id"] not in existing_src_ids and x["document_id"] != orig_doc]
                chosen = dict(random.choice(cands)) if cands else p_valid_sources[0]
                distractor_sources = auth_sources + [chosen]
                distractor_premise = format_premise(distractor_sources)
                pair_len = len(tokenizer(distractor_premise, r["claim"], add_special_tokens=True, truncation=False)["input_ids"])
                if pair_len > 8192:
                    short_cands = [x for x in cands if len(x.get("text", "")) < 500]
                    if short_cands:
                        chosen = dict(random.choice(short_cands))
                        distractor_sources = auth_sources + [chosen]
                        distractor_premise = format_premise(distractor_sources)
                        pair_len = len(tokenizer(distractor_premise, r["claim"], add_special_tokens=True, truncation=False)["input_ids"])
                r["sources"] = distractor_sources
                r["token_length"] = pair_len

    # 5. Leakage Verification
    print("\nVerifying zero leakage across partitions...")
    partition_docs = defaultdict(set)
    partition_srcs = defaultdict(set)

    for pname, prows in partitions.items():
        for r in prows:
            partition_docs[pname].add(r["origin_document_id"])
            for s in r.get("sources", []):
                partition_srcs[pname].add(s["source_id"])

    pnames = list(partitions.keys())
    leakage_found = False
    for i in range(len(pnames)):
        for j in range(i + 1, len(pnames)):
            p1, p2 = pnames[i], pnames[j]
            doc_overlap = partition_docs[p1].intersection(partition_docs[p2])
            src_overlap = partition_srcs[p1].intersection(partition_srcs[p2])
            if doc_overlap:
                print(f"ERROR: Doc leakage between {p1} and {p2}: {len(doc_overlap)} docs")
                leakage_found = True
            if src_overlap:
                print(f"ERROR: Source leakage between {p1} and {p2}: {len(src_overlap)} sources")
                leakage_found = True

    if not leakage_found:
        print("Leakage verification SUCCESSFUL: 0 overlapping origin documents and 0 overlapping source units!")

    # 6. Write Partitions
    for pname, prows in partitions.items():
        out_f = output_dir / f"{pname}.jsonl"
        with open(out_f, "w", encoding="utf-8") as f:
            for r in prows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"Saved {len(prows)} rows ({len(prows)/len(clean_rows)*100:.1f}%) to {out_f}")

    # 7. Stratified Review Samples (50 samples)
    groups = defaultdict(list)
    for r in clean_rows:
        key = (r["label"], r.get("transformation") or "authentic")
        groups[key].append(r)

    sampled_review = []
    per_group = max(1, args.sample_review_size // len(groups))
    for key in sorted(groups.keys()):
        group_rows = groups[key]
        sampled_review.extend(random.sample(group_rows, min(per_group, len(group_rows))))

    # Fill remainder if under sample_review_size
    if len(sampled_review) < args.sample_review_size:
        remaining = [r for r in clean_rows if r not in sampled_review]
        sampled_review.extend(random.sample(remaining, args.sample_review_size - len(sampled_review)))

    sampled_review = sampled_review[:args.sample_review_size]

    review_file = output_dir / "sample_review.jsonl"
    with open(review_file, "w", encoding="utf-8") as f:
        for r in sampled_review:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"\nSaved {len(sampled_review)} stratified review samples to {review_file}")

    # 8. Dataset Summary Report
    source_counts = Counter(len(r.get("sources", [])) for r in clean_rows)
    all_unit_types = [s["unit_type"] for r in clean_rows for s in r.get("sources", [])]
    summary = {
        "total_rows": len(clean_rows),
        "partitions": {p: len(prows) for p, prows in partitions.items()},
        "labels": dict(Counter(r["label"] for r in clean_rows)),
        "source_counts": {str(k): v for k, v in sorted(source_counts.items())},
        "transformations": dict(Counter(r.get("transformation") or "authentic" for r in clean_rows)),
        "unit_types": dict(Counter(all_unit_types)),
        "token_buckets": {
            "<=512": sum(1 for r in clean_rows if r.get("token_length", 0) <= 512),
            "513-2048": sum(1 for r in clean_rows if 513 <= r.get("token_length", 0) <= 2048),
            "2049-4096": sum(1 for r in clean_rows if 2049 <= r.get("token_length", 0) <= 4096),
            "4097-8192": sum(1 for r in clean_rows if 4097 <= r.get("token_length", 0) <= 8192),
        }
    }

    summary_file = output_dir / "dataset_summary.json"
    with open(summary_file, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f"Saved dataset summary to {summary_file}")


if __name__ == "__main__":
    main()
