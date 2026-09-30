#!/usr/bin/env python3
"""
Turn model-extracted thesis claims into claim/source pairs in the data/*.jsonl
format, with a blank label.

Inputs, per thesis N (docs.txt line N names the thesis):
- <sentences>/docN.txt: numbered sentences, "[page.n] text", footnotes inlined
  as a parenthesis after the sentence that carried the marker.
- <claims>/<prefix>docN.jsonl: one object per note with note_id, note,
  claim_from, claim_to and keep.

For each kept note, the note text goes to lagen.nu citations/extract, and every
target is checked with resolve. A claim with an invalid target is dropped. The
cited units are fetched with CitedUnitResolver, as in extract_training_data.py,
and a claim is kept only when every source resolves. A pinpoint that lagen.nu
cannot cut out yet (a page of an older proposition without page data) is kept
with an empty text, to be filled in later. There is no
length limit. lagen.nu answers are cached in <out.jsonl>.api-cache.json.

Usage: python scripts/thesis_llm_pairs.py <docs.txt> <sentences> <claims> <out.jsonl> [--prefix sonnet_] [--split-mb 40]

The rows go to <out-stem>.part1.jsonl, .part2.jsonl, … of at most --split-mb
MB each (40 by default; 0 writes one file). GitHub refuses files over 100 MB,
and a part grows by about 15 % once its empty source texts are filled in.
"""

import argparse
import concurrent.futures
import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

from transformers import AutoTokenizer

from backend.resolver import CitedUnitResolver, format_premise

API = "https://lagen.nu/api/v1"
EXTRACTION_OPTIONS = {"whole_documents": ["case", "eu-case", "echr", "international-case"], "case_names": "with_identifier"}


def api(path, body=None):
    """A lagen.nu API call, retried on 429/5xx, timeouts and dropped connections.
    Returns None when every attempt fails."""
    for attempt in range(5):
        request = urllib.request.Request(
            f"{API}/{path}",
            data=json.dumps(body).encode("utf-8") if body is not None else None,
            headers={"Content-Type": "application/json", "User-Agent": "slopcheck-thesis-pairs"},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504):
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(2 ** attempt)
    return None


def sentences(path):
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\[(\d+\.\d+)\] (.*)$", line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def order(sid):
    page, n = sid.split(".")
    return int(page), int(n)


def claim_texts(row, sents):
    """The claim with and without the note's parenthesis."""
    ids = sorted((i for i in sents if order(row["claim_from"]) <= order(i) <= order(row["claim_to"])), key=order)
    actual = " ".join(sents[i] for i in ids)
    note = f"({row['note']})"
    if note in actual:
        # The last occurrence belongs to the note sentence; the note ends the claim.
        at = actual.rindex(note)
        claim = actual[:at] + actual[at + len(note):]
    else:
        # The sentence splitter can cut a long note in two ("… p." / "46–47.)").
        # Find where the note starts and rebuild the text as the claim plus the note.
        at = actual.rfind("(" + row["note"][:20])
        if at < 0:
            return None, None
        claim = actual[:at]
        actual = f"{claim.strip()} {note}"
    claim = re.sub(r"\s+([.,;:])", r"\1", re.sub(r"\s+", " ", claim)).strip()
    return claim, actual


class PartWriter:
    """One output file, or numbered parts of at most `split_mb` MB each."""

    def __init__(self, path, split_mb=None):
        self.path, self.limit = Path(path), split_mb * 1024 * 1024 if split_mb else None
        self.part, self.size, self.handle = 0, 0, None

    def __enter__(self):
        self._open()
        return self

    def _open(self):
        if self.handle:
            self.handle.close()
        self.part += 1
        target = self.path if not self.limit else self.path.with_name(f"{self.path.stem}.part{self.part}{self.path.suffix}")
        self.handle, self.size = open(target, "w", encoding="utf-8"), 0

    def write(self, line):
        size = len(line.encode("utf-8"))
        if self.limit and self.size and self.size + size > self.limit:
            self._open()
        self.handle.write(line)
        self.size += size

    def __exit__(self, *exc):
        self.handle.close()


def main():
    parser = argparse.ArgumentParser(description="Build unlabelled pairs from model-extracted thesis claims.")
    parser.add_argument("docs")
    parser.add_argument("sentences")
    parser.add_argument("claims")
    parser.add_argument("output")
    parser.add_argument("--prefix", default="sonnet_")
    parser.add_argument("--model-name", default="BalaRajesh1/mmbert-small-nli")
    parser.add_argument("--split-mb", type=int, default=40, help="write parts of at most this many MB (0: one file)")
    args = parser.parse_args()

    tokenizer = AutoTokenizer.from_pretrained(args.model_name)
    resolver = CitedUnitResolver()
    cache_path = Path(f"{args.output}.api-cache.json")
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {"extract": {}, "status": {}}
    extract_cache, status_cache = cache["extract"], cache["status"]
    stats = Counter()
    pool = concurrent.futures.ThreadPoolExecutor(8)

    def status(uri):
        response = api(f"resolve?{urllib.parse.urlencode({'q': uri})}")
        if response is None:
            return None
        invalid = any(item.get("uri") == uri and item.get("invalid") for item in response.get("recognized", []))
        return "invalid" if invalid else "found" if response.get("results") else "unconfirmed"

    names = [line for line in Path(args.docs).read_text(encoding="utf-8").splitlines() if line.strip()]

    with PartWriter(args.output, args.split_mb) as out:
        for n, name in enumerate(names, start=1):
            claims_path = Path(args.claims) / f"{args.prefix}doc{n}.jsonl"
            if not claims_path.exists():
                stats["thesis_without_claims_file"] += 1
                continue
            sents = sentences(Path(args.sentences) / f"doc{n}.txt")
            document = name.removesuffix(".pdf")
            rows = []
            for line in claims_path.read_text(encoding="utf-8").splitlines():
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    stats["bad_json_line"] += 1
                    continue
                if isinstance(row, dict) and row.get("keep") and isinstance(row.get("note"), str):
                    rows.append(row)
            # The model can report one note twice with different claim ranges; the first report counts.
            unique = {}
            for row in rows:
                if (row.get("note_id"), row["note"]) in unique:
                    stats["duplicate_note"] += 1
                else:
                    unique[(row.get("note_id"), row["note"])] = row
            rows = list(unique.values())
            # Fetch this thesis's lagen.nu answers in parallel before building its rows.
            notes = sorted({row["note"] for row in rows} - extract_cache.keys())
            # A call that fails after all retries is not cached, so a later run tries again.
            for note, result in zip(notes, pool.map(lambda note: api("citations/extract", {"text": note, **EXTRACTION_OPTIONS}), notes)):
                if result is not None:
                    extract_cache[note] = result["occurrences"]
            uris = sorted({t["uri"] for row in rows for o in extract_cache.get(row["note"], []) for t in o.get("targets", [])} - status_cache.keys())
            for uri, result in zip(uris, pool.map(status, uris)):
                if result is not None:
                    status_cache[uri] = result
            list(pool.map(lambda uri: resolver.load_artifact(uri), sorted({u.split("#")[0] for u in uris})))
            cache_path.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
            for row in rows:
                stats["kept_by_model"] += 1
                try:
                    claim, actual = claim_texts(row, sents)
                except (KeyError, ValueError, AttributeError):
                    claim = None
                if not claim:
                    stats["note_not_found_in_text"] += 1
                    continue

                if row["note"] not in extract_cache:
                    stats["lagen_nu_unreachable"] += 1
                    continue
                occurrences = extract_cache[row["note"]]
                targets = []
                for occurrence in occurrences:
                    # "s. 159 f." / "s. 83 ff." after the pinpoint extends a förarbete page range.
                    end = occurrence["locations"][0]["end"]
                    following = re.match(r"\s*ff?\.", row["note"][end:])
                    citation = occurrence["text"] + (following.group(0) if following else "")
                    uris = [t["uri"] for t in occurrence.get("targets", [])]
                    # "49 kap. 13 och 14 §§" also targets the whole chapter; the sections are the source.
                    uris = [u for u in uris if not any(o.startswith(f"{u}P") for o in uris)]
                    # A provision names its act; "(1975:635)" alone does not cite the whole act.
                    specific = {u.split("#")[0] for u in uris if "#" in u}
                    targets += [(citation, u) for u in uris if "#" in u or u not in specific]
                if not targets:
                    stats["no_lagen_nu_citation"] += 1
                    continue

                if any(uri not in status_cache for _, uri in targets):
                    stats["lagen_nu_unreachable"] += 1
                    continue
                statuses = [status_cache[uri] for _, uri in targets]
                if "invalid" in statuses:
                    stats["invalid_source"] += 1
                    continue
                if "unconfirmed" in statuses:
                    stats["unconfirmed_source"] += 1
                    continue

                sources, seen = [], set()
                for citation, uri in targets:
                    if uri in seen:
                        continue
                    seen.add(uri)
                    res = resolver.resolve(uri, citation=citation)
                    # lagen.nu has no page data yet for older propositions, and some
                    # pinpoints cannot be cut out. They are kept with an empty text.
                    if res.get("abstain_reason") == "pinpoint_not_found":
                        stats[f"pinpoint_without_text_{res.get('unit_type')}"] += 1
                        res = {**res, "status": "ok", "text": ""}
                    elif res.get("status") != "ok" or not res.get("text"):
                        stats[f"unresolved_{res.get('abstain_reason') or res.get('unit_type')}"] += 1
                        sources = None
                        break
                    sources.append({
                        "citation": citation,
                        "source_id": res.get("source_id", uri).replace("https://lagen.nu/", ""),
                        "document_id": res.get("document_id", uri.split("#")[0]).replace("https://lagen.nu/", ""),
                        "unit_type": res.get("unit_type", "unknown"),
                        "text": (res.get("text") or "").strip(),
                    })
                if not sources:
                    stats["source_not_resolved"] += 1
                    continue

                # No length limit: the source is extracted mechanically. The
                # length only informs the later labelling step.
                token_length = len(tokenizer(format_premise(sources), claim, add_special_tokens=True, truncation=False)["input_ids"])
                origin_claim_id = f"{document}#{row['note_id']}"
                digest = hashlib.md5(f"{origin_claim_id}_{row['note']}_{sources[0]['source_id']}_{len(sources)}".encode("utf-8")).hexdigest()[:12]
                out.write(json.dumps({
                    "id": f"thesis_{digest}",
                    "claim": claim,
                    "actual_text": actual,
                    "sources": sources,
                    "label": "",
                    "origin_document_id": document,
                    "origin_paragraph": row["note_id"],
                    "origin_claim_id": origin_claim_id,
                    "origin": "thesis",
                    "transformation": None,
                    "token_length": token_length,
                }, ensure_ascii=False) + "\n")
                stats["written"] += 1
                for source in sources:
                    stats[f"unit_{source['unit_type']}"] += 1
    print(json.dumps(stats, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
