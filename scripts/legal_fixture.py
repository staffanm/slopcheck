"""Reads test/fixtures/legal-claims.jsonl as rows in the data/*.jsonl pair format.

The fixture rows reference their source by `file` in test/fixtures/legal-sources/,
because the client selects evidence from that markdown. This loader fills in
`text` the way the server resolver would cut the unit: a judgment from the
reporting court's heading onwards, a statute file whole.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "test" / "fixtures" / "legal-claims.jsonl"
SOURCES = ROOT / "test" / "fixtures" / "legal-sources"
LABELS = ("supported", "unsupported", "incorrect", "misleading")


def source_text(file: str) -> str:
    text = (SOURCES / file).read_text(encoding="utf-8")
    if file.startswith(("nja", "hfd")):
        match = re.search(r"##\s+(?:Högsta\s+domstolen|Högsta\s+förvaltningsdomstolen)", text)
        return (text[match.start():] if match else text).strip()
    return text.strip()


def load_legal_claims(path: Path = FIXTURE) -> list[dict]:
    """All 70 rows. Rows labelled "nonsensical" have no model label: the claim
    rules must reject them before any model runs."""
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    for row in rows:
        for source in row["sources"]:
            source["text"] = source_text(source["file"])
    return rows
