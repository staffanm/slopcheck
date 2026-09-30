import json
import os
import re
import time
from pathlib import Path
from typing import Any, Optional
import urllib.request
import urllib.parse

try:
    import brotli
except ImportError:
    brotli = None

# Default artifact directory (next to slopcheck repo)
DEFAULT_ARTIFACT_DIR = Path(__file__).resolve().parents[2] / "ferenda" / "site" / "data" / "artifact"
LOCAL_CACHE_DIR = Path(__file__).resolve().parent / ".artifact_cache"
NAMEDCASES_PATH = Path(__file__).resolve().parents[2] / "ferenda" / "ferenda" / "dv" / "data" / "namedcases.json"

COURT_NAMES = {
    "hd": "Högsta domstolen",
    "hfd": "Högsta förvaltningsdomstolen",
    "ra": "Regeringsrätten",
    "ad": "Arbetsdomstolen",
    "md": "Marknadsdomstolen",
    "mod": "Miljööverdomstolen",
    "mmod": "Mark- och miljööverdomstolen",
    "pmod": "Patent- och marknadsöverdomstolen",
    "mig": "Migrationsöverdomstolen",
}

def load_named_cases_map(path: Path = NAMEDCASES_PATH) -> dict[str, str]:
    """Loads map of HD case nicknames (e.g. 'brevinkastet' -> 'https://lagen.nu/dom/nja/2018s574')."""
    mapping = {}
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                cases = data.get("cases", []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
                for item in cases:
                    name = item.get("namn")
                    uri = item.get("uri")
                    if name and uri:
                        mapping[name.lower().strip()] = uri
        except Exception:
            pass
    return mapping

NAMED_CASES = load_named_cases_map()

def format_premise(sources: list[dict]) -> str:
    """
    Concatenates every resolved cited unit in citation order,
    each behind a plain-text header as defined in PRD Section 7:
    [Källa 1: prop. 2008/09:232 s. 25]
    <unit text>

    [Källa 2: NJA 2012 s. 262 p. 4–5]
    <unit text>
    """
    blocks = []
    for i, s in enumerate(sources, 1):
        cit = s.get("citation") or s.get("source_id", "")
        text = s.get("text", "").strip()
        blocks.append(f"[Källa {i}: {cit}]\n{text}")
    return "\n\n".join(blocks)

LOWER_COURT_START = re.compile(
    r"^\s*(?:HovR|Hovrätten|TR|Tingsrätten|Kammarrätten|Förvaltningsrätten|Länsrätten|Svea|Göta|"
    r"Hovrätten (?:för|över)|Skatterättsnämnden|Inskrivningsmyndigheten)\b",
    re.IGNORECASE,
)
DISSENT_START = re.compile(r"skiljaktig", re.IGNORECASE)


def deciding_dom_nodes(roots: Any) -> list:
    """Return the deciding court's own dom node(s) among the instans children.

    A betänkande is never evidence. When several dom nodes remain, drop those
    that open with a lower court's name, and keep the last one: the deciding
    court's decision closes a referat.
    """
    dom_nodes = []

    def collect(node):
        if isinstance(node, dict):
            if node.get("type") == "dom":
                dom_nodes.append(node)
            elif node.get("type") not in ("instans", "betankande"):
                for child in node.get("children", []):
                    collect(child)
        elif isinstance(node, list):
            for item in node:
                collect(item)

    collect(roots)
    if not dom_nodes:
        return [n for n in (roots if isinstance(roots, list) else [roots])
                if not (isinstance(n, dict) and n.get("type") == "betankande")]
    own = [n for n in dom_nodes if not LOWER_COURT_START.match(extract_node_text(n)[:120])]
    return [own[-1]] if own else [dom_nodes[-1]]


def cut_dissent(text: str) -> str:
    """Drop a dissenting opinion and everything after it."""
    paragraphs = text.split("\n\n")
    for index, paragraph in enumerate(paragraphs):
        if index > 0 and DISSENT_START.search(paragraph[:150]):
            return "\n\n".join(paragraphs[:index]).strip()
    return text


def own_text(node: dict) -> str:
    """A node's own text, without its children."""
    return extract_node_text({"text": node.get("text", "")})


def extract_node_text(node: Any) -> str:
    """Extracts raw plain text recursively from an AST node or text list."""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(extract_node_text(item) for item in node)
    if isinstance(node, dict):
        # A node's own text comes first, then its children (numbered points
        # under a stycke, paragraphs under a heading).
        own = ""
        if "text" in node:
            t = node["text"]
            if isinstance(t, list):
                parts = []
                for item in t:
                    if isinstance(item, str):
                        parts.append(item)
                    elif isinstance(item, dict) and "text" in item:
                        parts.append(item["text"])
                own = "".join(parts).strip()
            elif isinstance(t, str):
                own = t.strip()
        children = "\n\n".join(filter(None, (extract_node_text(c) for c in node.get("children", []))))
        return "\n\n".join(filter(None, (own, children)))
    return ""


def markdown_text(markdown: str) -> str:
    """lagen.nu's markdown as plain text: links, emphasis, heading and quote marks
    and escapes removed; paragraphs kept."""
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", markdown)
    text = re.sub(r"(?m)^[ \t]*(?:#{1,6}|>)[ \t]?", "", text)
    text = re.sub(r"\*\*|__|(?<!\w)[*_](?=\S)|(?<=\S)[*_](?!\w)", "", text)
    text = re.sub(r"\\([\\`*_{}\[\]()#+\-.!>])", r"\1", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def paragraph_range(citation: str, fragment: str, cjeu: bool = False) -> list[int]:
    """The numbered paragraphs a judgment citation points at: "p. 26", "punkterna
    7–9", "p. 42 och 45" in the citation text, or "#p26" / "#point-26" in the uri.
    A dash is a range; "och" (and, for the EU court, a comma) lists two paragraphs."""
    separators = r"och|–|-|," if cjeu else r"och|–|-"
    match = (re.search(rf"\bp(?:unkt(?:erna)?)?\.?\s*(\d+)(?:\s*({separators})\s*(\d+))?", citation, re.IGNORECASE)
             or re.fullmatch(r"(?:p|point-)(\d+)(?:(-)(\d+))?", fragment or ""))
    if not match:
        return []
    start = int(match.group(1))
    if not match.group(3):
        return [start]
    end = int(match.group(3))
    if match.group(2) in ("och", ","):
        return [start, end]
    # A "range" of more than ten paragraphs is a misread list, not a span.
    return list(range(start, end + 1)) if start <= end <= start + 10 else [start]


class CitedUnitResolver:
    def __init__(self, artifact_dir: Path | str | None = None, cache_dir: Path | str | None = None):
        self.artifact_dir = Path(artifact_dir) if artifact_dir else DEFAULT_ARTIFACT_DIR
        self.cache_dir = Path(cache_dir) if cache_dir else LOCAL_CACHE_DIR
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def load_artifact(self, uri: str) -> Optional[dict]:
        """
        Loads document artifact JSON for a given URI.
        First attempts to load from local artifact_dir; if not found, falls back
        to local cache or https://lagen.nu/api/v1/document.
        """
        clean_uri = uri.split("#")[0].rstrip("/")
        cached_file = self._cached_path(clean_uri)
        if cached_file.exists():
            try:
                with open(cached_file, "r", encoding="utf-8") as f:
                    return self._unwrap(json.load(f))
            except Exception:
                pass

        # Try finding in local artifact_dir
        local_data = self._load_from_local_artifact(clean_uri)
        if local_data:
            try:
                with open(cached_file, "w", encoding="utf-8") as f:
                    json.dump(local_data, f, ensure_ascii=False)
            except Exception:
                pass
            return local_data

        # Fallback to fetching via API
        api_data = self._fetch_from_api(clean_uri)
        if api_data:
            try:
                with open(cached_file, "w", encoding="utf-8") as f:
                    json.dump(api_data, f, ensure_ascii=False)
            except Exception:
                pass
            return api_data

        return None

    @staticmethod
    def _unwrap(data: Optional[dict]) -> Optional[dict]:
        # The document API returns the artifact inside an envelope with its metadata.
        if isinstance(data, dict) and "structure" not in data and isinstance(data.get("artifact"), dict):
            return data["artifact"]
        return data

    def _cached_path(self, clean_uri: str) -> Path:
        safe_name = re.sub(r"[^a-zA-Z0-9_\-]", "_", clean_uri) + ".json"
        return self.cache_dir / safe_name

    def _load_from_local_artifact(self, clean_uri: str) -> Optional[dict]:
        if not self.artifact_dir.exists():
            return None
        # A ferenda checkout stores artifacts either brotli-compressed or as plain JSON.
        for ext in (".json.br", ".json"):
            doc = self._load_local_with_ext(clean_uri, ext)
            if doc:
                return doc
        return None

    def _load_local_with_ext(self, clean_uri: str, ext: str) -> Optional[dict]:

        # SFS: e.g. https://lagen.nu/1915:218 -> sfs/1915/218.json.br
        sfs_match = re.search(r"lagen\.nu/(\d{4}):(\d+)", clean_uri)
        if sfs_match:
            year, num = sfs_match.groups()
            path = self.artifact_dir / "sfs" / year / f"{num}{ext}"
            if path.exists():
                return self._read_json_br(path)

        # Prop: e.g. https://lagen.nu/prop/2008/09:232 -> forarbete/prop/2008/2008-09-232.json.br
        prop_match = re.search(r"lagen\.nu/prop/(\d{4})/(\d+):(\d+)", clean_uri)
        if prop_match:
            y1, y2, num = prop_match.groups()
            filename = f"{y1}-{y2}-{num}{ext}"
            path = self.artifact_dir / "forarbete" / "prop" / y1 / filename
            if path.exists():
                return self._read_json_br(path)
            # Try searching under prop
            found = list((self.artifact_dir / "forarbete" / "prop").glob(f"**/{filename}"))
            if found:
                return self._read_json_br(found[0])

        # Dom / NJA / HFD / AD: e.g. https://lagen.nu/dom/nja/2019s271
        dom_match = re.search(r"lagen\.nu/dom/([a-z]+)/(\d{4})s(\d+)", clean_uri)
        if dom_match:
            court, year, page = dom_match.groups()
            filename = f"{court.upper()}_{year}_s_{page}{ext}"
            path = self.artifact_dir / "dom" / filename
            if path.exists():
                return self._read_json_br(path)

        dom_num_match = re.search(r"lagen\.nu/dom/([a-z]+)/(\d{4}):(\d+)", clean_uri)
        if dom_num_match:
            court, year, num = dom_num_match.groups()
            filename = f"{court.upper()}_{year}_nr_{num}{ext}"
            path = self.artifact_dir / "dom" / filename
            if path.exists():
                return self._read_json_br(path)
            filename_ref = f"{court.upper()}_{year}_ref_{num}{ext}"
            path_ref = self.artifact_dir / "dom" / filename_ref
            if path_ref.exists():
                return self._read_json_br(path_ref)

        dom_docket_match = re.search(r"lagen\.nu/dom/([a-z]+)/([A-Za-z0-9\-]+)", clean_uri)
        if dom_docket_match:
            court, docket = dom_docket_match.groups()
            docket_clean = re.sub(r"[^A-Za-z0-9]", "_", docket)
            patterns = [
                f"{court.upper()}_{docket_clean}{ext}",
                f"{court.upper()}O_{docket_clean}{ext}",
                f"{court.upper()[:2]}O_{docket_clean}{ext}",
                f"{court.upper()}_{docket}{ext}"
            ]
            for p_name in patterns:
                p_path = self.artifact_dir / "dom" / p_name
                if p_path.exists():
                    return self._read_json_br(p_path)

        # EURLEX CELEX: e.g. https://lagen.nu/celex/62015CJ0123
        celex_match = re.search(r"lagen\.nu/celex/([0-9A-Z]+)", clean_uri)
        if celex_match:
            celex = celex_match.group(1)
            found = list((self.artifact_dir / "eurlex").glob(f"**/{celex}{ext}"))
            if found:
                return self._read_json_br(found[0])

        return None

    def _fetch_from_api(self, clean_uri: str) -> Optional[dict]:
        api_url = f"https://lagen.nu/api/v1/document?{urllib.parse.urlencode({'uri': clean_uri})}"
        try:
            req = urllib.request.Request(api_url, headers={"Accept": "application/json", "User-Agent": "slopcheck-resolver"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    return self._unwrap(json.loads(resp.read().decode("utf-8")))
        except Exception:
            return None
        return None

    def _read_json_br(self, path: Path) -> Optional[dict]:
        if path.suffix == ".br" and not brotli:
            raise RuntimeError("brotli package is required to read .json.br artifacts")
        try:
            with open(path, "rb") as f:
                data = f.read()
            if path.suffix == ".br":
                data = brotli.decompress(data)
            return json.loads(data.decode("utf-8"))
        except Exception:
            return None

    def fetch_unit(self, uri: str) -> tuple[str, str]:
        """The text of one cited unit ("…/1915:218#P36", "…/prop/2008/09:232#sid25")
        from lagen.nu's document endpoint, as plain text. Returns (status, text):
        "ok", "document_not_found", "pinpoint_not_found" or "unreachable". Found
        units are cached on disk; a missing pinpoint is not, since lagen.nu can
        add page data later."""
        cached_file = self.cache_dir / ("unit_" + re.sub(r"[^a-zA-Z0-9_\-]", "_", uri) + ".json")
        if cached_file.exists():
            try:
                return "ok", json.loads(cached_file.read_text(encoding="utf-8"))["text"]
            except Exception:
                pass
        api_url = f"https://lagen.nu/api/v1/document?{urllib.parse.urlencode({'uri': uri, 'format': 'md'})}"
        request = urllib.request.Request(api_url, headers={"Accept": "application/json", "User-Agent": "slopcheck-resolver"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(request, timeout=60) as resp:
                    text = markdown_text(json.loads(resp.read().decode("utf-8")).get("markdown") or "")
                cached_file.write_text(json.dumps({"uri": uri, "text": text}, ensure_ascii=False), encoding="utf-8")
                return "ok", text
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    detail = json.loads(error.read() or b"{}").get("detail", "")
                    return ("document_not_found" if detail.startswith("no document") else "pinpoint_not_found"), ""
                if error.code not in (429, 500, 502, 503, 504):
                    return "unreachable", ""
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                pass
            time.sleep(2 ** attempt)
        return "unreachable", ""

    def _units(self, clean_uri: str, fragments: list[str], unit_type: str, source_id: str, citation: str) -> dict[str, Any]:
        """One or more units of a document (pages 83–84, paragraphs 7–9), joined.
        The first must exist; a later one that does not is left out."""
        texts = []
        for index, fragment in enumerate(fragments):
            status, text = self.fetch_unit(f"{clean_uri}#{fragment}")
            if status != "ok":
                if index == 0:
                    reason = {"document_not_found": "source_not_found"}.get(status, status)
                    return {"status": "abstain", "abstain_reason": reason, "text": "", "unit_type": unit_type,
                            "citation": citation, "source_id": source_id, "document_id": clean_uri}
                continue
            texts.append(text)
        text = "\n\n".join(filter(None, texts)).strip()
        return {
            "status": "ok" if text else "abstain",
            "abstain_reason": None if text else "pinpoint_not_found",
            "text": text,
            "unit_type": unit_type,
            "citation": citation,
            "source_id": source_id,
            "document_id": clean_uri,
        }

    def resolve(self, uri: str, citation: str = "") -> dict[str, Any]:
        """
        Resolves the exact cited unit for a given URI (and optional citation string)
        under Section 3 rules of the PRD. A pinpointed unit is fetched from
        lagen.nu's document endpoint; what is cut here is what that endpoint
        does not decide: which units a whole document or chapter citation stands
        for, and the pinpoint a citation carries only in its text ("p. 26",
        "s. 83 f.", see ferenda#112).
        """
        # Resolve named case if uri is not a full URL or is a case nickname
        if not uri.startswith("http"):
            clean_name = re.sub(r"[”\"'«»]", "", uri).strip().lower()
            first_word = clean_name.split()[0] if clean_name else ""
            if clean_name in NAMED_CASES:
                uri = NAMED_CASES[clean_name]
            elif first_word in NAMED_CASES:
                base_uri = NAMED_CASES[first_word]
                p_m = re.search(r"p(?:unkt)?\.?\s*(\d+)", clean_name)
                uri = f"{base_uri}#p{p_m.group(1)}" if p_m else base_uri

        # If still not found and citation contains a named case, try resolving via citation
        if not uri.startswith("http") and citation:
            clean_cit = re.sub(r"[”\"'«»]", "", citation).strip().lower()
            first_cit = clean_cit.split()[0] if clean_cit else ""
            if first_cit in NAMED_CASES:
                base_uri = NAMED_CASES[first_cit]
                p_m = re.search(r"p(?:unkt)?\.?\s*(\d+)", clean_cit)
                uri = f"{base_uri}#p{p_m.group(1)}" if p_m else base_uri

        clean_uri = uri.split("#")[0]
        fragment = uri.split("#")[1] if "#" in uri else ""

        def abstain(reason, unit_type, source_id=uri):
            return {"status": "abstain", "abstain_reason": reason, "text": "", "unit_type": unit_type,
                    "citation": citation, "source_id": source_id, "document_id": clean_uri}

        # 1. Statute: a whole act or chapter is not one comparable unit.
        if re.search(r"lagen\.nu/\d{4}:\d+", clean_uri):
            if not fragment:
                return abstain("unit_unbounded", "statute_act", clean_uri)
            if re.fullmatch(r"K\d+[a-z]?", fragment):
                return abstain("unit_unbounded", "statute_chapter")
            unit_type = ("statute_stycke" if re.search(r"P\d+[a-z]*S\d+", fragment)
                         else "statute_provision" if re.search(r"P\d", fragment) else "document_unit")
            return self._units(clean_uri, [fragment], unit_type, uri, citation)

        # 2. Proposition, SOU, Ds, committee directive and committee report: the cited
        # page, and the next ones for "s. 83 f." / "s. 83 ff.".
        kind = re.search(r"lagen\.nu/(prop|sou|ds|dir|bet)/", clean_uri)
        if kind:
            page = re.search(r"sid(\d+)", fragment) or re.search(r"s\.\s*(\d+)", citation)
            if not page:
                return abstain("unit_unbounded", f"{kind.group(1)}_whole", clean_uri)
            first = int(page.group(1))
            following = re.search(r"\bs\.\s*\d+\s*(ff?)\b\.?", citation)
            extra = {"f": 1, "ff": 2}.get(following.group(1), 0) if following else 0
            return self._units(clean_uri, [f"sid{p}" for p in range(first, first + extra + 1)],
                               f"{kind.group(1)}_page", f"{clean_uri}#sid{first}", citation)

        # 3. Court judgment: numbered paragraphs, or the deciding court's own text.
        if "lagen.nu/dom" in clean_uri:
            pinpoints = paragraph_range(citation, fragment)
            if pinpoints:
                source_id = f"{clean_uri}#p{pinpoints[0]}" + (f"-{pinpoints[-1]}" if len(pinpoints) > 1 else "")
                return self._units(clean_uri, [f"p{n}" for n in pinpoints], "case_pinpoint", source_id, citation)
            doc = self.load_artifact(clean_uri)
            return self._resolve_judgment(doc, clean_uri, citation) if doc else abstain("source_not_found", "unknown")

        # 4. EU: a judgment's numbered paragraphs or its assessment; an act's article.
        if "lagen.nu/celex/6" in clean_uri:
            pinpoints = paragraph_range(citation, fragment, cjeu=True)
            if pinpoints:
                source_id = f"{clean_uri}#p{pinpoints[0]}" + (f"-{pinpoints[-1]}" if len(pinpoints) > 1 else "")
                return self._units(clean_uri, [f"point-{n}" for n in pinpoints], "cjeu_pinpoint", source_id, citation)
            doc = self.load_artifact(clean_uri)
            return self._resolve_cjeu(doc, clean_uri, citation) if doc else abstain("source_not_found", "unknown")
        if "lagen.nu/celex/" in clean_uri and fragment:
            return self._units(clean_uri, [fragment], "eu_article", uri, citation)

        # 5. Any other document cited at a unit (a treaty article, a regulation §).
        if fragment:
            return self._units(clean_uri, [fragment], "document_unit", uri, citation)

        # Default fallback: the whole document
        doc = self.load_artifact(clean_uri)
        if not doc:
            return abstain("source_not_found", "unknown")
        text = extract_node_text(doc.get("structure", []))
        return {
            "status": "ok" if text else "abstain",
            "abstain_reason": None if text else "empty_unit",
            "text": text,
            "unit_type": "generic_document",
            "citation": citation,
            "source_id": uri,
            "document_id": clean_uri,
        }

    def _resolve_judgment(self, doc: dict, clean_uri: str, citation: str) -> dict[str, Any]:
        """
        A judgment cited as a whole (Section 3): the deciding court's own text only
        (domskal and domslut), without lower instances, betänkande, headnote and
        dissent -- or the betänkande the court adopted. lagen.nu has no part
        fragment for this yet (ferenda#114).
        """
        # Find deciding court instans
        # Court is read from doc or URI: /dom/nja/ -> Högsta domstolen; /dom/hfd/ -> Högsta förvaltningsdomstolen
        court_name = doc.get("court_namn")
        if not court_name:
            court_slug = clean_uri.split("/")[4] if len(clean_uri.split("/")) > 4 else ""
            court_name = COURT_NAMES.get(court_slug.lower(), "Högsta domstolen")

        structure = doc.get("structure", [])
        deciding_instans = None

        for node in structure:
            if isinstance(node, dict) and node.get("type") == "instans":
                if node.get("court") == court_name or (court_name == "Högsta domstolen" and node.get("court") in ["Högsta domstolen", "HD"]):
                    deciding_instans = node

        # If structure is flat or has no instans (e.g. HFD reports), use structure directly
        search_roots = deciding_instans.get("children", []) if deciding_instans else structure
        # Older referats store the hovrätt decision as a dom node inside the
        # deciding court's instans, and a betänkande carries its own numbered
        # paragraphs. Only the deciding court's own dom node is evidence.
        search_roots = deciding_dom_nodes(search_roots)

        # Case 2: Blanket citation - deciding court's domskal and domslut only
        domskal_nodes = []
        domslut_nodes = []

        def find_dom_parts(node):
            if isinstance(node, dict):
                n_type = node.get("type")
                if n_type == "domskal":
                    domskal_nodes.append(node)
                elif n_type == "domslut":
                    domslut_nodes.append(node)
                elif n_type not in ["instans", "betankande"]:
                    for c in node.get("children", []):
                        find_dom_parts(c)
            elif isinstance(node, list):
                for item in node:
                    find_dom_parts(item)

        find_dom_parts(search_roots)

        all_text = []
        if domskal_nodes:
            all_text.append(extract_node_text(domskal_nodes))
        if domslut_nodes:
            all_text.append(extract_node_text(domslut_nodes))

        text = cut_dissent("\n\n".join(filter(None, all_text)).strip())
        if re.search(r"i enlighet med betänkandet", text[:400], re.IGNORECASE):
            # The court adopted the referent's proposal: its reasoning is the betänkande.
            instans_children = deciding_instans.get("children", []) if deciding_instans else structure
            betankande = [n for n in instans_children if isinstance(n, dict) and n.get("type") == "betankande"]
            if betankande:
                text = "\n\n".join(filter(None, (extract_node_text(betankande[-1]), text)))
        return {
            "status": "ok" if text else "abstain",
            "abstain_reason": None if text else "empty_unit",
            "text": text,
            "unit_type": "case_judgment",
            "citation": citation,
            "source_id": clean_uri,
            "document_id": clean_uri,
        }

    def _resolve_cjeu(self, doc: dict, clean_uri: str, citation: str) -> dict[str, Any]:
        """
        A CJEU judgment cited as a whole (Section 3): the court's assessment
        (Prövning av tolkningsfrågan up to Rättegångskostnader).
        """
        structure = doc.get("structure", [])

        # Blanket citation: assessment section
        # The judgment proper sits under the level-1 heading "Dom"; everything
        # before it is the preamble (parties, judges, procedure).
        judgment_nodes = [n for n in structure if isinstance(n, dict) and n.get("type") == "heading"
                          and own_text(n).strip().lower() in ("dom", "domskäl", "beslut")]
        body = judgment_nodes[-1].get("children", []) if judgment_nodes else structure
        # The assessment starts at the first heading about the questions or the
        # court's examination, or, failing that, right after the facts of the
        # national case, and ends at "Rättegångskostnader".
        assessment_keywords = ("prövning", "tolkningsfråg", "den första frågan", "bedömning", "domstolens svar",
                               "frågan huruvida", "den enda frågan")
        facts_keywords = ("nationella domstolen", "målet vid", "tvisten", "bakgrund")
        headings = [(i, own_text(n).strip().lower()) for i, n in enumerate(body)
                    if isinstance(n, dict) and n.get("type") == "heading"]
        start = next((i for i, h in headings if any(h.startswith(kw) or re.match(r"^[ivx]+\s*[–-]\s*" + kw, h)
                                                    for kw in assessment_keywords)), None)
        if start is None:
            facts = [i for i, h in headings if any(kw in h for kw in facts_keywords)]
            start = facts[-1] + 1 if facts else None
        assessment_nodes = []
        if start is not None:
            for node in body[start:]:
                if isinstance(node, dict) and node.get("type") == "heading" and "rättegångskostnader" in own_text(node).lower():
                    break
                assessment_nodes.append(node)

        text = "\n\n".join(filter(None, (extract_node_text(n) for n in assessment_nodes))).strip()
        if not text:
            # No assessment heading found: the numbered paragraphs of the judgment.
            text = extract_node_text(body)

        return {
            "status": "ok" if text else "abstain",
            "abstain_reason": None if text else "empty_unit",
            "text": text,
            "unit_type": "cjeu_assessment",
            "citation": citation,
            "source_id": clean_uri,
            "document_id": clean_uri,
        }
