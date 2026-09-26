import json
import os
import re
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
                    return json.load(f)
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

    def _cached_path(self, clean_uri: str) -> Path:
        safe_name = re.sub(r"[^a-zA-Z0-9_\-]", "_", clean_uri) + ".json"
        return self.cache_dir / safe_name

    def _load_from_local_artifact(self, clean_uri: str) -> Optional[dict]:
        if not self.artifact_dir.exists():
            return None

        # SFS: e.g. https://lagen.nu/1915:218 -> sfs/1915/218.json.br
        sfs_match = re.search(r"lagen\.nu/(\d{4}):(\d+)", clean_uri)
        if sfs_match:
            year, num = sfs_match.groups()
            path = self.artifact_dir / "sfs" / year / f"{num}.json.br"
            if path.exists():
                return self._read_json_br(path)

        # Prop: e.g. https://lagen.nu/prop/2008/09:232 -> forarbete/prop/2008/2008-09-232.json.br
        prop_match = re.search(r"lagen\.nu/prop/(\d{4})/(\d+):(\d+)", clean_uri)
        if prop_match:
            y1, y2, num = prop_match.groups()
            filename = f"{y1}-{y2}-{num}.json.br"
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
            filename = f"{court.upper()}_{year}_s_{page}.json.br"
            path = self.artifact_dir / "dom" / filename
            if path.exists():
                return self._read_json_br(path)

        dom_num_match = re.search(r"lagen\.nu/dom/([a-z]+)/(\d{4}):(\d+)", clean_uri)
        if dom_num_match:
            court, year, num = dom_num_match.groups()
            filename = f"{court.upper()}_{year}_nr_{num}.json.br"
            path = self.artifact_dir / "dom" / filename
            if path.exists():
                return self._read_json_br(path)
            filename_ref = f"{court.upper()}_{year}_ref_{num}.json.br"
            path_ref = self.artifact_dir / "dom" / filename_ref
            if path_ref.exists():
                return self._read_json_br(path_ref)

        dom_docket_match = re.search(r"lagen\.nu/dom/([a-z]+)/([A-Za-z0-9\-]+)", clean_uri)
        if dom_docket_match:
            court, docket = dom_docket_match.groups()
            docket_clean = re.sub(r"[^A-Za-z0-9]", "_", docket)
            patterns = [
                f"{court.upper()}_{docket_clean}.json.br",
                f"{court.upper()}O_{docket_clean}.json.br",
                f"{court.upper()[:2]}O_{docket_clean}.json.br",
                f"{court.upper()}_{docket}.json.br"
            ]
            for p_name in patterns:
                p_path = self.artifact_dir / "dom" / p_name
                if p_path.exists():
                    return self._read_json_br(p_path)

        # EURLEX CELEX: e.g. https://lagen.nu/celex/62015CJ0123
        celex_match = re.search(r"lagen\.nu/celex/([0-9A-Z]+)", clean_uri)
        if celex_match:
            celex = celex_match.group(1)
            found = list((self.artifact_dir / "eurlex").glob(f"**/{celex}.json.br"))
            if found:
                return self._read_json_br(found[0])

        return None

    def _fetch_from_api(self, clean_uri: str) -> Optional[dict]:
        api_url = f"https://lagen.nu/api/v1/document?{urllib.parse.urlencode({'uri': clean_uri})}"
        try:
            req = urllib.request.Request(api_url, headers={"Accept": "application/json", "User-Agent": "slopcheck-resolver"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    return json.loads(resp.read().decode("utf-8"))
        except Exception:
            return None
        return None

    def _read_json_br(self, path: Path) -> Optional[dict]:
        if not brotli:
            raise RuntimeError("brotli package is required to read .json.br artifacts")
        try:
            with open(path, "rb") as f:
                decompressed = brotli.decompress(f.read()).decode("utf-8")
                return json.loads(decompressed)
        except Exception:
            return None

    def resolve(self, uri: str, citation: str = "") -> dict[str, Any]:
        """
        Resolves the exact cited unit for a given URI (and optional citation string)
        under Section 3 rules of the PRD.
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

        doc = self.load_artifact(clean_uri)
        if not doc:
            return {
                "status": "abstain",
                "abstain_reason": "source_not_found",
                "text": "",
                "unit_type": "unknown",
                "citation": citation,
                "source_id": uri,
                "document_id": clean_uri,
            }

        # 1. Statute Provision (SFS)
        if re.search(r"lagen\.nu/\d{4}:\d+", clean_uri):
            return self._resolve_statute(doc, clean_uri, fragment, citation)

        # 2. Proposition (Prop)
        if "lagen.nu/prop" in clean_uri:
            return self._resolve_proposition(doc, clean_uri, fragment, citation)

        # 3. Court Judgment (HD, HFD, AD, etc.)
        if "lagen.nu/dom" in clean_uri:
            return self._resolve_judgment(doc, clean_uri, fragment, citation)

        # 4. CJEU (EUR-Lex)
        if "lagen.nu/celex" in clean_uri or doc.get("doctype") in ["eu_case", "judgment"]:
            return self._resolve_cjeu(doc, clean_uri, fragment, citation)

        # Default fallback
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

    def _resolve_statute(self, doc: dict, clean_uri: str, fragment: str, citation: str) -> dict[str, Any]:
        """
        Statute provision rule (Section 3):
        - Paragraph (§) with all stycken.
        - Specific stycke if pinpointed.
        - Whole act or chapter citation -> abstain("unit_unbounded").
        """
        if not fragment:
            return {
                "status": "abstain",
                "abstain_reason": "unit_unbounded",
                "text": "",
                "unit_type": "statute_act",
                "citation": citation,
                "source_id": clean_uri,
                "document_id": clean_uri,
            }

        # Chapter-only reference e.g. K1, K18
        if re.match(r"^K\d+$", fragment):
            return {
                "status": "abstain",
                "abstain_reason": "unit_unbounded",
                "text": "",
                "unit_type": "statute_chapter",
                "citation": citation,
                "source_id": f"{clean_uri}#{fragment}",
                "document_id": clean_uri,
            }

        structure = doc.get("structure", [])

        # Parse target paragraph and optional stycke
        p_match = re.search(r"P(\d+[a-z]*)", fragment)
        s_match = re.search(r"S(\d+)", fragment)

        target_p_id = f"P{p_match.group(1)}" if p_match else None
        target_s_id = f"S{s_match.group(1)}" if s_match else None

        matched_p_node = None
        matched_s_node = None

        def search_statute(node):
            nonlocal matched_p_node, matched_s_node
            if isinstance(node, dict):
                node_id = node.get("id") or ""
                # Match paragraph
                if target_p_id and (node_id == target_p_id or node_id.endswith(f"_{target_p_id}") or target_p_id in node_id.split("_")):
                    matched_p_node = node
                    if target_s_id:
                        for child in node.get("children", []):
                            child_id = child.get("id") or ""
                            if target_s_id in child_id:
                                matched_s_node = child
                                return
                    return
                # Look inside children
                for c in node.get("children", []):
                    search_statute(c)
                    if matched_p_node and (not target_s_id or matched_s_node):
                        return
            elif isinstance(node, list):
                for item in node:
                    search_statute(item)
                    if matched_p_node and (not target_s_id or matched_s_node):
                        return

        search_statute(structure)

        if target_s_id and matched_s_node:
            text = extract_node_text(matched_s_node)
            return {
                "status": "ok" if text else "abstain",
                "abstain_reason": None if text else "pinpoint_not_found",
                "text": text,
                "unit_type": "statute_stycke",
                "citation": citation,
                "source_id": f"{clean_uri}#{fragment}",
                "document_id": clean_uri,
            }

        if matched_p_node:
            # Paragraph with all stycken
            text_parts = []
            beteckning = matched_p_node.get("beteckning", "")
            for child in matched_p_node.get("children", []):
                child_text = extract_node_text(child)
                if child_text:
                    text_parts.append(child_text)
            if not text_parts:
                t = extract_node_text(matched_p_node)
                if t:
                    text_parts.append(t)
            full_text = "\n\n".join(text_parts).strip()
            if beteckning and not full_text.startswith(beteckning):
                full_text = f"{beteckning} {full_text}"

            return {
                "status": "ok" if full_text else "abstain",
                "abstain_reason": None if full_text else "pinpoint_not_found",
                "text": full_text,
                "unit_type": "statute_provision",
                "citation": citation,
                "source_id": f"{clean_uri}#{fragment}",
                "document_id": clean_uri,
            }

        return {
            "status": "abstain",
            "abstain_reason": "pinpoint_not_found",
            "text": "",
            "unit_type": "statute_provision",
            "citation": citation,
            "source_id": f"{clean_uri}#{fragment}",
            "document_id": clean_uri,
        }

    def _resolve_proposition(self, doc: dict, clean_uri: str, fragment: str, citation: str) -> dict[str, Any]:
        """
        Proposition rule (Section 3):
        - Cited page (#sid25) or page range.
        - Every node whose 'page' equals cited page.
        """
        page_num = None
        sid_match = re.search(r"sid(\d+)", fragment) or re.search(r"s\.\s*(\d+)", citation)
        if sid_match:
            page_num = int(sid_match.group(1))
        # "s. 83 f." means pages 83-84, "s. 83 ff." the following pages as well.
        following = re.search(r"\bs\.\s*\d+\s*(ff?)\b\.?", citation)
        extra_pages = {"f": 1, "ff": 2}.get(following.group(1), 0) if following else 0

        if page_num is None:
            return {
                "status": "abstain",
                "abstain_reason": "unit_unbounded",
                "text": "",
                "unit_type": "prop_whole",
                "citation": citation,
                "source_id": clean_uri,
                "document_id": clean_uri,
            }

        structure = doc.get("structure", [])
        page_nodes = []

        wanted_pages = set(range(page_num, page_num + extra_pages + 1))

        def collect_pages(node):
            # Each node contributes its own text only; a section that starts on
            # the page must not drag in the pages of all its children.
            if isinstance(node, dict):
                if node.get("page") in wanted_pages:
                    page_nodes.append(node)
                for c in node.get("children", []):
                    collect_pages(c)
            elif isinstance(node, list):
                for item in node:
                    collect_pages(item)

        collect_pages(structure)
        text = "\n\n".join(filter(None, (own_text(n) for n in page_nodes))).strip()

        return {
            "status": "ok" if text else "abstain",
            "abstain_reason": None if text else "pinpoint_not_found",
            "text": text,
            "unit_type": "prop_page",
            "citation": citation,
            "source_id": f"{clean_uri}#sid{page_num}",
            "document_id": clean_uri,
        }

    def _resolve_judgment(self, doc: dict, clean_uri: str, fragment: str, citation: str) -> dict[str, Any]:
        """
        HD / HFD judgment rule (Section 3):
        - With pinpoint (p. 7, punkt 7): stycke node with that ordinal under deciding court's dom > domskal.
        - Without pinpoint: deciding court's own text only (domskal and domslut).
          Excludes lower instances (instans), betankande, and headnote.
        """
        # Determine pinpoint paragraph numbers if any
        pinpoints: list[int] = []
        p_match = re.search(r"p(?:unkt)?\s*(\d+)(?:\s*(?:och|–|-)\s*(\d+))?", citation, re.IGNORECASE)
        if p_match:
            start_p = int(p_match.group(1))
            end_p = int(p_match.group(2)) if p_match.group(2) else start_p
            pinpoints = list(range(start_p, end_p + 1))
        elif fragment:
            frag_match = re.search(r"p(\d+)(?:-(\d+))?", fragment)
            if frag_match:
                start_p = int(frag_match.group(1))
                end_p = int(frag_match.group(2)) if frag_match.group(2) else start_p
                pinpoints = list(range(start_p, end_p + 1))

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

        # Case 1: Pinpointed paragraph(s)
        if pinpoints:
            matched_nodes = []
            def search_ordinals(node):
                if isinstance(node, dict):
                    ord_val = node.get("ordinal")
                    try:
                        if ord_val is not None and int(ord_val) in pinpoints:
                            matched_nodes.append(node)
                    except (ValueError, TypeError):
                        pass
                    for c in node.get("children", []):
                        search_ordinals(c)
                elif isinstance(node, list):
                    for item in node:
                        search_ordinals(item)

            search_ordinals(search_roots)
            text = "\n\n".join(filter(None, (extract_node_text(n) for n in matched_nodes))).strip()
            source_id = f"{clean_uri}#p{pinpoints[0]}" + (f"-{pinpoints[-1]}" if len(pinpoints) > 1 else "")
            return {
                "status": "ok" if text else "abstain",
                "abstain_reason": None if text else "pinpoint_not_found",
                "text": text,
                "unit_type": "case_pinpoint",
                "citation": citation,
                "source_id": source_id,
                "document_id": clean_uri,
            }

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

    def _resolve_cjeu(self, doc: dict, clean_uri: str, fragment: str, citation: str) -> dict[str, Any]:
        """
        CJEU judgment rule (Section 3):
        - Pinpointed (punkt 45, p. 45): numbered paragraph.
        - Blanket: court's assessment (Prövning av tolkningsfrågan up to Rättegångskostnader).
        """
        # Determine pinpoint number if any
        pinpoints: list[int] = []
        p_match = (re.search(r"\bp(?:unkt(?:erna)?)?\.?\s*(\d+)(?:\s*(?:och|–|-|,)\s*(\d+))?", citation, re.IGNORECASE)
                   or re.search(r"p(\d+)(?:-(\d+))?", fragment))
        if p_match:
            start_p = int(p_match.group(1))
            end_p = int(p_match.group(2)) if p_match.group(2) else start_p
            if start_p <= end_p <= start_p + 10:
                pinpoints = list(range(start_p, end_p + 1))
            else:
                pinpoints = [start_p]
        p_num = pinpoints[0] if pinpoints else None

        structure = doc.get("structure", [])

        if p_num is not None:
            matched = []
            def find_cjeu_p(node):
                if isinstance(node, dict):
                    num_val = node.get("num") or node.get("ordinal")
                    try:
                        if num_val is not None and int(num_val) in pinpoints:
                            matched.append(node)
                    except (ValueError, TypeError):
                        pass
                    for c in node.get("children", []):
                        find_cjeu_p(c)
                elif isinstance(node, list):
                    for item in node:
                        find_cjeu_p(item)

            find_cjeu_p(structure)
            text = "\n\n".join(filter(None, (extract_node_text(n) for n in matched))).strip()
            source_id = f"{clean_uri}#p{p_num}" + (f"-{pinpoints[-1]}" if len(pinpoints) > 1 else "")
            return {
                "status": "ok" if text else "abstain",
                "abstain_reason": None if text else "pinpoint_not_found",
                "text": text,
                "unit_type": "cjeu_pinpoint",
                "citation": citation,
                "source_id": source_id,
                "document_id": clean_uri,
            }

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
