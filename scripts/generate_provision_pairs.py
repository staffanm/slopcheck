#!/usr/bin/env python3
"""Generate provision-based training pairs in memo register.

The production input is a memo sentence that names a provision and states a
rule, paired with that provision's text. The judgment-derived data has no such
rows, and only one unsupported row where the source is a provision of another
act. This script reads real provisions verbatim from the local SFS artifacts and
generates claims around each one:

    memo claim about provision P            + P                  -> supported
    same claim                              + provision of act Q  -> unsupported
    same claim                              + BM25 near provision -> unsupported
    same claim                              + neighbouring §      -> unsupported
    contradicted claim                      + P                  -> incorrect
    overstated claim                        + P                  -> misleading

Half of the claims carry a citation frame ("Enligt 4 § avtalslagen gäller att
..."). For unsupported rows the frame names the supplied (wrong) provision, as
a miscitation does in production. A local LLM writes the claims and then judges
every pair against the intended label; disagreeing pairs are dropped.

Run: python scripts/generate_provision_pairs.py --n-provisions 700
"""

import argparse
import hashlib
import json
import random
import re
import sys
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import brotli

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.resolver import extract_node_text  # noqa: E402
from backend.windowing import SimpleBM25  # noqa: E402

FIXTURE_ACTS = {"1915:218", "1736:0123_2", "1736:0123_1", "1981:130", "1975:635", "1990:931",
                "1942:740", "1962:700", "1972:207", "1949:105"}
PARTITION_RATIOS = (("train", 0.75), ("validation", 0.10), ("calibration", 0.075), ("test", 0.075))
FRAMES = [
    "Enligt {cit} gäller att {claim}",
    "{Cit} stadgar att {claim}",
    "Detta följer av {cit}, som föreskriver att {claim}",
    "Av {cit} framgår att {claim}",
    "Detta följer av svensk rätt, särskilt {cit}, som stadgar att {claim}",
    "I {cit} anges att {claim}",
    "{claim_cap} Detta följer av {cit}.",
    "Enligt svensk rätt, se {cit}, gäller att {claim}",
]
STYCKEN = {1: "första", 2: "andra", 3: "tredje", 4: "fjärde", 5: "femte", 6: "sjätte"}


def llm(url: str, model: str, prompt: str, max_tokens: int, temperature: float) -> str:
    payload = {"model": model, "think": False, "stream": False,
               "messages": [{"role": "user", "content": prompt}],
               "options": {"num_predict": max_tokens, "temperature": temperature}}
    req = urllib.request.Request(f"{url}/api/chat", data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))["message"]["content"].strip()


def act_citation_forms(title: str, alternate: str | None, sfs: str) -> list[str]:
    """Return realistic ways to name the act, e.g. 'avtalslagen (1915:218)'."""
    forms = []
    m = re.match(r"^(Lag|Förordning|Kungörelse)\s*\((\d{4}:[\w_]+)\)\s+(.+)$", title)
    if m:
        kind = {"Lag": "lagen", "Förordning": "förordningen", "Kungörelse": "kungörelsen"}[m.group(1)]
        rest = m.group(3).strip().rstrip(".")
        forms.append(f"{kind} ({sfs}) {rest}")
    m = re.match(r"^([A-ZÅÄÖ][\wåäö]*?)(lag|balk|förordning|kungörelse|stadga)\s*\((\d{4}:[\w_]+)\)", title)
    if m:
        stem = (m.group(1) + m.group(2)).lower()
        suffix = {"lag": "en", "balk": "en", "förordning": "en", "kungörelse": "n", "stadga": "n"}[m.group(2)]
        forms.append(f"{stem}{suffix} ({sfs})")
        forms.append(f"{stem}{suffix}")
    if alternate and re.fullmatch(r"[A-ZÅÄÖ][\w]*", alternate):
        forms.append(alternate)
    if not forms:
        forms.append(f"{title.rstrip('.')}")
    return forms


def provision_citation(chapter: str | None, para: str, act_form: str) -> str:
    return f"{chapter} kap. {para} § {act_form}" if chapter else f"{para} § {act_form}"


def load_provisions(artifact_dir: Path, rng: random.Random, n_acts: int) -> list[dict]:
    files = sorted(artifact_dir.glob("*/*.json.br"))
    rng.shuffle(files)
    provisions = []
    acts_used = 0
    for path in files:
        if acts_used >= n_acts:
            break
        sfs = f"{path.parent.name}:{path.name.split('.')[0]}"
        if sfs in FIXTURE_ACTS:
            continue
        try:
            doc = json.loads(brotli.decompress(path.read_bytes()))
        except Exception:
            continue
        props = doc.get("metadata", {}).get("properties", {})
        if props.get("rpubl:upphavandedatum") or props.get("rpubl:upphavdAv"):
            continue
        title = props.get("dcterms:title") or ""
        if not title:
            continue
        forms = act_citation_forms(title, props.get("dcterms:alternate"), sfs)
        found = []

        def walk(node, chapter=None):
            if isinstance(node, dict):
                if node.get("type") == "kapitel":
                    chapter = (node.get("id") or "")[1:] or None
                if node.get("type") == "paragraf":
                    stycken = [c for c in node.get("children", []) if c.get("type") == "stycke"]
                    bet = next((c.get("beteckning") for c in stycken if c.get("beteckning")), None)
                    texts = [extract_node_text(c) for c in stycken]
                    texts = [t for t in texts if t]
                    if bet and texts:
                        para = bet.replace("§", "").strip()
                        text = "\n\n".join(texts)
                        if not text.startswith(bet):
                            text = f"{bet} {text}"
                        found.append({"chapter": chapter, "para": para, "text": text,
                                      "source_id": f"{sfs}#{'K' + chapter if chapter else ''}P{para}",
                                      "document_id": sfs, "forms": forms, "title": title})
                    return
                for child in node.get("children", []):
                    walk(child, chapter)
            elif isinstance(node, list):
                for child in node:
                    walk(child, chapter)

        walk(doc.get("structure", []))
        usable = [p for p in found if 150 <= len(p["text"]) <= 1200
                  and not re.search(r"upphävd|har upphört|Har upphävts|utgår", p["text"][:80])]
        if len(usable) < 3:
            continue
        for p in usable:
            p["siblings"] = [q for q in found if q is not p]
        provisions.extend(usable)
        acts_used += 1
    return provisions


def partition_for(document_id: str, salt: str) -> str:
    digest = hashlib.sha256(f"{salt}:{document_id}".encode("utf-8")).digest()
    value = int.from_bytes(digest[:4], "big") / 2**32
    acc = 0.0
    for name, ratio in PARTITION_RATIOS:
        acc += ratio
        if value < acc:
            return name
    return "train"


GEN_PROMPT = """Nedan följer en paragraf ur en svensk författning.

{cit}:
{text}

Skriv tre påståenden på modern juridisk svenska, som i en promemoria. Varje påstående ska vara en mening, utan hänvisning till paragrafen, utan citattecken.
1. "stod": ett påstående som paragrafen tydligt fastslår (omformulerat, inte ordagrant).
2. "motsagelse": ett påstående som paragrafen direkt säger emot (ändra t.ex. en tidsfrist, ett antal, vem som får göra något, eller lägg till eller ta bort en negation).
3. "overdrift": ett påstående som paragrafen stödjer i huvudfallet men som utelämnar ett villkor, undantag eller förbehåll som paragrafen anger, eller som gör "får" till "ska".

Svara endast med ett JSON-objekt med nycklarna "stod", "motsagelse" och "overdrift"."""

JUDGE_PROMPT = """Lagtext:
{text}

Påstående:
{claim}

Bedöm påståendet enbart mot lagtexten ovan. Använd ingen egen kunskap om svensk rätt. Svara med exakt ett ord:
STÖDS – lagtexten fastslår det påståendet säger.
STÖDS_INTE – lagtexten säger ingenting om det påståendet handlar om.
MOTSÄGS – lagtexten säger motsatsen till påståendet.
ÖVERDRIVET – lagtexten stödjer huvudregeln, men påståendet utelämnar ett villkor eller undantag som lagtexten anger."""

JUDGE_OK = {"supported": "STÖDS", "unsupported": "STÖDS_INTE", "incorrect": "MOTSÄGS", "misleading": "ÖVERDRIVET"}


def normalize_verdict(text: str) -> str:
    text = text.strip().upper().replace(" ", "_")
    for verdict in ("STÖDS_INTE", "STÖDS", "MOTSÄGS", "ÖVERDRIV"):
        if text.startswith(verdict):
            return "ÖVERDRIVET" if verdict == "ÖVERDRIV" else verdict
    return text[:20]


def strip_claim(text: str) -> str:
    text = text.strip().strip('"”“').strip()
    return text[0].upper() + text[1:] if text else text


def frame_claim(rng: random.Random, claim: str, citation: str, with_frame: bool) -> str:
    if not with_frame:
        return claim
    frame = rng.choice(FRAMES)
    body = claim.rstrip(".")
    lower = body[0].lower() + body[1:]
    return frame.format(cit=citation, Cit=citation[0].upper() + citation[1:], claim=lower, claim_cap=body + ".").rstrip(".") + "."


def source_entry(p: dict, citation: str) -> dict:
    return {"citation": citation, "source_id": p["source_id"], "document_id": p["document_id"],
            "unit_type": "statute_provision", "text": p["text"]}


def make_family(p: dict, pool: list[dict], bm25: SimpleBM25, rng: random.Random, args) -> list[dict]:
    citation_own = provision_citation(p["chapter"], p["para"], rng.choice(p["forms"]))
    prompt = GEN_PROMPT.format(cit=citation_own, text=p["text"])
    try:
        raw = llm(args.ollama_url, args.model, prompt, 400, 0.4)
        raw = raw[raw.index("{"): raw.rindex("}") + 1]
        gen = json.loads(raw)
        claims = {k: strip_claim(gen[k]) for k in ("stod", "motsagelse", "overdrift")}
    except Exception as exc:
        print(f"skip {p['source_id']}: {exc}", file=sys.stderr)
        return []
    if any(len(c) < 25 for c in claims.values()):
        return []

    candidates = []
    # supported
    candidates.append(("supported", "provision_memo", claims["stod"], p, citation_own))
    # unsupported: random other act
    other = rng.choice([q for q in pool if q["document_id"] != p["document_id"]])
    candidates.append(("unsupported", "unrelated_act", claims["stod"], other,
                       provision_citation(other["chapter"], other["para"], rng.choice(other["forms"]))))
    # unsupported: BM25-near provision of another act, or neighbouring § in the same act
    if rng.random() < 0.5:
        scores = bm25.score(claims["stod"])
        ranked = sorted(range(len(pool)), key=lambda i: scores[i], reverse=True)
        near = next((pool[i] for i in ranked if pool[i]["document_id"] != p["document_id"]), None)
        if near is not None:
            candidates.append(("unsupported", "topic_near_act", claims["stod"], near,
                               provision_citation(near["chapter"], near["para"], rng.choice(near["forms"]))))
    else:
        neighbours = [q for q in p["siblings"] if q["chapter"] == p["chapter"] and 150 <= len(q["text"]) <= 1500]
        if neighbours:
            near = rng.choice(neighbours)
            candidates.append(("unsupported", "adjacent_provision", claims["stod"], near,
                               provision_citation(near["chapter"], near["para"], rng.choice(p["forms"]))))
    candidates.append(("incorrect", "contradiction_memo", claims["motsagelse"], p, citation_own))
    candidates.append(("misleading", "overstatement_memo", claims["overdrift"], p, citation_own))

    rows = []
    family_id = f"sfs/{p['source_id']}"
    for label, transformation, claim, src, citation in candidates:
        try:
            verdict = llm(args.ollama_url, args.model, JUDGE_PROMPT.format(text=src["text"], claim=claim), 16, 0.0)
        except Exception as exc:
            print(f"judge error {p['source_id']}: {exc}", file=sys.stderr)
            continue
        verdict = normalize_verdict(verdict)
        if verdict != JUDGE_OK[label]:
            rows.append({"_rejected": True, "label": label, "transformation": transformation, "verdict": verdict})
            continue
        with_frame = rng.random() < 0.5
        text = frame_claim(rng, claim, citation, with_frame)
        row_id = hashlib.sha256(f"{family_id}|{transformation}|{src['source_id']}".encode()).hexdigest()[:12]
        rows.append({
            "id": f"sfs_{transformation}_{row_id}",
            "claim": text,
            "sources": [source_entry(src, citation)],
            "label": label,
            "origin_document_id": family_id,
            "origin_paragraph": p["para"],
            "origin_claim_id": family_id,
            "origin": "counterfactual" if label != "supported" else "generated",
            "transformation": transformation,
            "claim_frame": with_frame,
            "token_length": int(len(text + src["text"]) / 3.5),
        })
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", default="../ferenda/site/data/artifact/sfs")
    parser.add_argument("--n-acts", type=int, default=400)
    parser.add_argument("--n-provisions", type=int, default=700)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    parser.add_argument("--model", default="gemma4:26b")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--out", default="data/provision_pairs.jsonl")
    parser.add_argument("--data-dir", default="data", help="Partition files to append to; empty string to skip.")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    provisions = load_provisions(Path(args.artifact_dir), rng, args.n_acts)
    rng.shuffle(provisions)
    pool = provisions
    chosen = provisions[: args.n_provisions]
    print(f"{len(provisions)} provisions from {len({p['document_id'] for p in provisions})} acts; generating for {len(chosen)}")
    bm25 = SimpleBM25([q["text"] for q in pool])

    out_path = Path(args.out)
    done = set()
    if out_path.exists():
        for line in out_path.open(encoding="utf-8"):
            done.add(json.loads(line)["origin_claim_id"])
    todo = [p for p in chosen if f"sfs/{p['source_id']}" not in done]
    print(f"{len(done)} families already generated, {len(todo)} to go")

    stats = Counter()
    with out_path.open("a", encoding="utf-8") as out, ThreadPoolExecutor(max_workers=args.workers) as executor:
        family_rngs = [random.Random(f"{args.seed}:{p['source_id']}") for p in todo]
        for i, rows in enumerate(executor.map(lambda pr: make_family(pr[0], pool, bm25, pr[1], args), zip(todo, family_rngs))):
            for row in rows:
                if row.get("_rejected"):
                    stats[f"rejected_{row['label']}_{row['transformation']}_{row['verdict']}"] += 1
                    continue
                stats[f"kept_{row['label']}"] += 1
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
            out.flush()
            if (i + 1) % 25 == 0:
                print(f"{i + 1}/{len(todo)} families; " + ", ".join(f"{k}={v}" for k, v in sorted(stats.items()) if k.startswith("kept")), flush=True)
    for key in sorted(stats):
        print(f"{key}: {stats[key]}")

    if args.data_dir:
        rows = [json.loads(line) for line in out_path.open(encoding="utf-8")]
        existing = set()
        for name, _ in PARTITION_RATIOS:
            path = Path(args.data_dir) / f"{name}.jsonl"
            if path.exists():
                existing.update(json.loads(line)["id"] for line in path.open(encoding="utf-8") if line.strip())
        added = Counter()
        handles = {name: (Path(args.data_dir) / f"{name}.jsonl").open("a", encoding="utf-8") for name, _ in PARTITION_RATIOS}
        for row in rows:
            if row["id"] in existing:
                continue
            part = partition_for(row["sources"][0]["document_id"] if row["label"] != "supported" else row["origin_document_id"].split("#")[0].replace("sfs/", ""), str(args.seed))
            # keep a family together: partition by the originating act
            part = partition_for(row["origin_document_id"].split("#")[0].replace("sfs/", ""), str(args.seed))
            handles[part].write(json.dumps(row, ensure_ascii=False) + "\n")
            added[part] += 1
        for handle in handles.values():
            handle.close()
        print("appended:", dict(added))


if __name__ == "__main__":
    main()
