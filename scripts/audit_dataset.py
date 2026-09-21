#!/usr/bin/env python3
"""Audit semantic-classifier partitions for leakage and label shortcuts.

The checks in this file deliberately use only the serialized examples.  They can
therefore be run before training, in CI, and against archived datasets without
loading a tokenizer or a model.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path
from typing import Iterable


DEFAULT_PARTITIONS = {
    "train": Path("data/train.jsonl"),
    "validation": Path("data/validation.jsonl"),
    "calibration": Path("data/calibration.jsonl"),
    "test": Path("data/test.jsonl"),
}


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def normalized_source_text(text: str) -> str:
    return " ".join(text.split())


def source_text_fingerprint(text: str) -> str:
    normalized = normalized_source_text(text)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def pair_fingerprint(row: dict) -> str:
    """Hash the exact model-facing claim and ordered sources."""
    payload = {
        "claim": row.get("claim", "").strip(),
        "sources": [
            {
                "citation": source.get("citation", "").strip(),
                "source_id": source.get("source_id", "").strip(),
                "text": normalized_source_text(source.get("text", "")),
            }
            for source in row.get("sources", [])
        ],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _values(rows: Iterable[dict], kind: str) -> set[str]:
    if kind == "origin_document":
        return {row.get("origin_document_id", "") for row in rows if row.get("origin_document_id")}
    if kind == "origin_claim":
        return {row.get("origin_claim_id", "") for row in rows if row.get("origin_claim_id")}
    if kind == "claim_text":
        return {row.get("claim", "").strip() for row in rows if row.get("claim", "").strip()}

    result = set()
    for row in rows:
        for source in row.get("sources", []):
            if kind == "source_id" and source.get("source_id"):
                result.add(source["source_id"])
            elif kind == "source_document" and source.get("document_id"):
                result.add(source["document_id"])
            elif kind == "source_text" and source.get("text", "").strip():
                result.add(source_text_fingerprint(source["text"]))
    return result


def audit_partitions(partitions: dict[str, list[dict]]) -> dict:
    rows = [row for part_rows in partitions.values() for row in part_rows]
    errors: list[dict] = []

    marker_rows = [
        row for row in rows
        if any("intilliggande" in source.get("citation", "").casefold()
               for source in row.get("sources", []))
    ]
    if marker_rows:
        errors.append({
            "code": "synthetic_label_marker",
            "count": len(marker_rows),
            "labels": dict(Counter(row.get("label") for row in marker_rows)),
            "example_ids": [row.get("id") for row in marker_rows[:5]],
        })

    by_pair: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_pair[pair_fingerprint(row)].append(row)
    conflicting_pairs = [
        group for group in by_pair.values()
        if len({row.get("label") for row in group}) > 1
    ]
    if conflicting_pairs:
        errors.append({
            "code": "conflicting_exact_pairs",
            "count": len(conflicting_pairs),
            "label_sets": dict(Counter(
                "/".join(sorted({row.get("label", "") for row in group}))
                for group in conflicting_pairs
            )),
            "example_ids": [[row.get("id") for row in group] for group in conflicting_pairs[:5]],
        })

    duplicate_ids = Counter(row.get("id") for row in rows)
    duplicate_ids = [row_id for row_id, count in duplicate_ids.items() if row_id and count > 1]
    if duplicate_ids:
        errors.append({
            "code": "duplicate_row_ids",
            "count": len(duplicate_ids),
            "example_ids": duplicate_ids[:5],
        })

    overlap_counts = Counter()
    overlap_examples: dict[str, list[str]] = {}
    split_names = list(partitions)
    strict_kinds = (
        "origin_document", "origin_claim", "claim_text", "source_id",
        "source_document", "source_text",
    )
    value_cache = {
        (name, kind): _values(partitions[name], kind)
        for name in split_names for kind in strict_kinds
    }
    for left, right in combinations(split_names, 2):
        for kind in strict_kinds:
            overlap = value_cache[left, kind] & value_cache[right, kind]
            if overlap:
                key = f"{left}/{right}:{kind}"
                overlap_counts[kind] += len(overlap)
                overlap_examples[key] = sorted(overlap)[:5]

        # A judgment may be an origin in one split and evidence in another.  Those
        # roles used to have different graph namespaces and silently leaked.
        cross_role = (
            value_cache[left, "origin_document"] & value_cache[right, "source_document"]
        ) | (
            value_cache[right, "origin_document"] & value_cache[left, "source_document"]
        )
        if cross_role:
            key = f"{left}/{right}:origin_source_cross_role"
            overlap_counts["origin_source_cross_role"] += len(cross_role)
            overlap_examples[key] = sorted(cross_role)[:5]

    if overlap_counts:
        errors.append({
            "code": "partition_leakage",
            "counts": dict(overlap_counts),
            "examples": overlap_examples,
        })

    return {
        "ok": not errors,
        "rows": len(rows),
        "partitions": {name: len(part_rows) for name, part_rows in partitions.items()},
        "labels": dict(Counter(row.get("label") for row in rows)),
        "transformations": dict(Counter(row.get("transformation") or "authentic" for row in rows)),
        "errors": errors,
    }


def parse_partition(value: str) -> tuple[str, Path]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("partition must be NAME=PATH")
    name, path = value.split("=", 1)
    if not name or not path:
        raise argparse.ArgumentTypeError("partition must be NAME=PATH")
    return name, Path(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fail-closed audit of semantic dataset partitions.")
    parser.add_argument(
        "--partition", action="append", type=parse_partition, default=[], metavar="NAME=PATH",
        help="Partition to audit; repeat for multiple files. Defaults to the four data/*.jsonl partitions.",
    )
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    args = parser.parse_args()

    paths = dict(args.partition) if args.partition else DEFAULT_PARTITIONS
    partitions = {name: read_jsonl(path) for name, path in paths.items()}
    report = audit_partitions(partitions)

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(f"Audited {report['rows']} rows: " + ", ".join(
            f"{name}={count}" for name, count in report["partitions"].items()
        ))
        if report["ok"]:
            print("Dataset audit passed.")
        else:
            print(f"Dataset audit failed with {len(report['errors'])} error groups:")
            for error in report["errors"]:
                print(f"- {error['code']}: {json.dumps(error, ensure_ascii=False, sort_keys=True)}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
