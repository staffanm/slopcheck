"""Reads test/fixtures/legal-claims.jsonl as rows in the data/*.jsonl pair format.

The fixture rows reference their source by `file` in test/fixtures/legal-sources/,
because the client selects evidence from that markdown. This loader fills in
`text` the way the server resolver would cut the unit: a judgment as the
supreme court's own text (its reasons and its decision, without the appeal,
the parties' claims, the reporting clerk's proposal or the lower courts), a
statute file whole.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "test" / "fixtures" / "legal-claims.jsonl"
SOURCES = ROOT / "test" / "fixtures" / "legal-sources"
LABELS = ("supported", "unsupported", "incorrect", "misleading")


# The court's own text starts after "HD (justitieråden …) meddelade … följande dom" or
# "Högsta förvaltningsdomstolen (2013-10-29, …) yttrade" and ends at "HD:s dom meddelad",
# "HD:s beslut meddelat" or the case number line.
COURT_START = re.compile(r"^(?:HD \(justitieråd.*\) meddelade .*följande (?:dom|beslut)|Högsta förvaltningsdomstolen \(.*\) yttrade).*$", re.M)
COURT_END = re.compile(r"^(?:HD:s (?:dom|beslut) meddela[dt]|#* ?Mål nr)", re.M)


def source_text(file: str) -> str:
    text = (SOURCES / file).read_text(encoding="utf-8")
    if file.startswith(("nja", "hfd")):
        start = COURT_START.search(text)
        if start is None:
            raise ValueError(f"{file}: no line that starts the court's own text")
        end = COURT_END.search(text, start.end())
        return text[start.end():end.start() if end else len(text)].strip()
    return text.strip()


def load_legal_claims(path: Path = FIXTURE) -> list[dict]:
    """All rows. Rows labelled "nonsensical" have no model label: the claim
    rules must reject them before any model runs."""
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    for row in rows:
        for source in row["sources"]:
            source["text"] = source_text(source["file"])
    return rows
