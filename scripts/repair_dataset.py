#!/usr/bin/env python3
"""Repair label leaks and empty sources in the generated partitions.

Three repairs, all measured by the dataset audit of 21 September 2026:

1. Adjacent-unit negatives carried the marker "(intilliggande)" in their
   citation, and the citation named the original unit while the text was the
   neighbour. The marker went into the premise header and identified the
   unsupported class. Production never emits it. The citation now names the
   supplied unit, without any marker.
2. Rows whose every source is a CJEU preamble or a bare heading carry no
   evidence. They are removed.
3. Unsupported rows that reuse a source of their supported sibling are
   contradictory. They are removed.
4. A whole-judgment source that duplicates a pinpoint of the same judgment
   in the same row (a popular name followed by the NJA citation) is dropped.
5. Judgment sources are re-resolved through backend.resolver, which now keeps
   only the deciding court's own dom node, ignores betänkande paragraphs for
   pinpoints and cuts dissents. Sources whose artifact is not available
   locally keep their text.

The partition files are tracked in git, so the originals are in history.

Run: python scripts/repair_dataset.py [--data-dir data]
"""

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.resolver import CitedUnitResolver  # noqa: E402

PARTITIONS = ("train", "validation", "calibration", "test")
MARKER = "(intilliggande)"
PREAMBLE_START = re.compile(
    r"^(I mål|I de förenade|DOMSTOLENS|TRIBUNALENS|Mål \d|In Case|EUROPAPARLAMENTET|Avis juridique|Rådets|Kommissionens)"
)
BARE_HEADING = re.compile(r"^Prövning av (tolkningsfråg\w+|talan)\s*$")


def is_stub(source: dict) -> bool:
    text = source.get("text", "").strip()
    if not text:
        return True
    if not source.get("unit_type", "").startswith("cjeu"):
        return False
    if BARE_HEADING.match(text):
        return True
    if len(text) < 600:
        return True
    return bool(PREAMBLE_START.match(text)) and len(text) < 1500


def celex_case(celex: str) -> str:
    m = re.match(r"6(\d{4})(CJ|TJ|CO|TO)(\d{4})", celex)
    if not m:
        return celex
    year, kind, num = m.groups()
    prefix = "T" if kind.startswith("T") else "C"
    return f"{prefix}-{int(num)}/{year[2:]}"


def citation_for_unit(citation: str, source_id: str, unit_type: str) -> str:
    """Return a citation that names the unit in source_id."""
    base, _, fragment = source_id.partition("#")
    if unit_type == "prop_page":
        m = re.search(r"sid(\d+)", fragment)
        if not m:
            return citation
        page = m.group(1)
        if re.search(r"\bs\.\s*\d+", citation):
            return re.sub(r"\bs\.\s*\d+(\s*f+\.?)?", f"s. {page}", citation, count=1)
        m2 = re.match(r"prop/(\d{4}/\d{2}):(\d+)", base)
        return f"prop. {m2.group(1)}:{m2.group(2)} s. {page}" if m2 else citation
    if unit_type == "case_pinpoint":
        m = re.search(r"p(\d+)", fragment)
        if not m:
            return citation
        point = m.group(1)
        if re.search(r"\bp\.\s*\d+", citation):
            return re.sub(r"\bp\.\s*\d+(\s*(?:och|-|–)\s*\d+)?", f"p. {point}", citation, count=1)
        m2 = re.match(r"dom/nja/(\d{4})s(\d+)", base)
        if m2:
            return f"NJA {m2.group(1)} s. {m2.group(2)} p. {point}"
        m2 = re.match(r"dom/hfd/(\d{4}):(\d+)", base)
        if m2:
            return f"HFD {m2.group(1)} ref. {m2.group(2)} p. {point}"
        return citation
    if unit_type == "cjeu_pinpoint":
        m = re.search(r"p(\d+)", fragment)
        if not m:
            return citation
        point = m.group(1)
        m2 = re.match(r"celex/(\w+)", base)
        case = celex_case(m2.group(1)) if m2 else ""
        name = re.match(r"\s*([CT]-\d+/\d+)\s*,?\s*([^,]*)", citation)
        if name and name.group(2).strip() and not name.group(2).strip().startswith("EU:"):
            return f"{case or name.group(1)}, {name.group(2).strip()}, punkt {point}"
        return f"mål {case or citation}, punkt {point}"
    if unit_type in ("statute_provision", "statute_stycke"):
        m = re.search(r"(?:K(\d+))?P(\d+[a-z]?)(?:S(\d+))?", fragment)
        if not m:
            return citation
        chapter, para, stycke = m.groups()
        stycken = {"1": "första", "2": "andra", "3": "tredje", "4": "fjärde", "5": "femte", "6": "sjätte"}
        act = re.sub(r"^.*?§+\s*(?:(?:första|andra|tredje|fjärde|femte|sjätte) stycket\s*)?(?:(?:första|andra|tredje) meningen\s*)?", "", citation).strip()
        act = re.sub(r"^\d+\s*kap\.\s*", "", act).strip()
        if not act or re.fullmatch(r"[\d\s,och\-–§]*", act):
            act = f"({base})"
        parts = []
        if chapter:
            parts.append(f"{chapter} kap.")
        parts.append(f"{para} §")
        if stycke and stycke in stycken:
            parts.append(f"{stycken[stycke]} stycket")
        parts.append(act)
        return " ".join(parts)
    return citation


def repair_citation(source: dict) -> tuple[str, bool]:
    citation = source.get("citation", "")
    if MARKER not in citation:
        return citation, False
    cleaned = citation.replace(MARKER, "").strip()
    return citation_for_unit(cleaned, source.get("source_id", ""), source.get("unit_type", "")), True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data")
    parser.add_argument("--no-reresolve", action="store_true", help="Skip re-resolving judgment sources.")
    args = parser.parse_args()
    data_dir = Path(args.data_dir)

    partitions: dict[str, list[dict]] = {}
    for name in PARTITIONS:
        path = data_dir / f"{name}.jsonl"
        with path.open(encoding="utf-8") as handle:
            partitions[name] = [json.loads(line) for line in handle if line.strip()]

    supported_units: dict[str, set[str]] = defaultdict(set)
    for rows in partitions.values():
        for row in rows:
            if row["label"] == "supported" and row.get("transformation") in (None, "paraphrase", "reordered_sources"):
                supported_units[row["origin_claim_id"]].update(s["source_id"] for s in row["sources"])

    stats = Counter()
    resolver = None if args.no_reresolve else CitedUnitResolver()
    resolved_cache: dict[str, str | None] = {}
    for name, rows in partitions.items():
        kept = []
        for row in rows:
            pinpointed = {s["document_id"] for s in row["sources"] if s.get("unit_type") == "case_pinpoint"}
            before = len(row["sources"])
            row["sources"] = [s for s in row["sources"] if not (s.get("unit_type") == "case_judgment" and s["document_id"] in pinpointed)]
            stats["duplicate_whole_judgment_dropped"] += before - len(row["sources"])
            for source in row["sources"]:
                new_citation, changed = repair_citation(source)
                if changed:
                    source["citation"] = new_citation
                    stats["citations_rewritten"] += 1
                if resolver is not None and source.get("unit_type") in ("case_judgment", "case_pinpoint"):
                    source_id = source["source_id"]
                    if source_id not in resolved_cache:
                        result = resolver.resolve(f"https://lagen.nu/{source_id}", citation=source.get("citation", ""))
                        resolved_cache[source_id] = result["text"].strip() if result.get("status") == "ok" and result.get("text") else None
                    new_text = resolved_cache[source_id]
                    if new_text is None:
                        stats["judgment_not_reresolved"] += 1
                    elif new_text != source["text"].strip():
                        stats["judgment_text_changed"] += 1
                        source["text"] = new_text
                    else:
                        stats["judgment_text_unchanged"] += 1
            if all(is_stub(s) for s in row["sources"]):
                stats[f"removed_stub_{row['label']}"] += 1
                continue
            if row["label"] == "unsupported" and any(
                s["source_id"] in supported_units[row["origin_claim_id"]] for s in row["sources"]
            ):
                stats["removed_contradictory_unsupported"] += 1
                continue
            kept.append(row)
        stats[f"kept_{name}"] = len(kept)
        with (data_dir / f"{name}.jsonl").open("w", encoding="utf-8") as handle:
            for row in kept:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    for key in sorted(stats):
        print(f"{key}: {stats[key]}")


if __name__ == "__main__":
    main()
