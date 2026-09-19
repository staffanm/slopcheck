import re
from typing import Any

SEMANTIC_LABELS = {
    "correct": ("Stöd hittat", "Källavsnittet tycks stödja påståendet. Granska villkor och sammanhang."),
    "incorrect": ("Möjlig motsägelse", "Källavsnittet kan motsäga påståendet. Kontrollera villkor och sammanhang."),
    "unsupported": ("Stöd saknas", "De jämförda avsnitten gav inget tydligt stöd. Det bevisar inte att påståendet är fel."),
    "nonsensical": ("Meningslöst", "Påståendet saknar juridisk innebörd eller kan inte bedömas meningsfullt."),
    "abstain": ("Kunde inte bedömas", "Jämförelsen ger inget tillräckligt säkert resultat."),
}

# Swedish legal verbs and verb inflection endings
VERB_PATTERN = re.compile(
    r"(?<!\w)(?:är|var|vara|har|hade|ska|skall|kan|får|måste|gäller|gällde|ansvarar|kräver|innebär|"
    r"utgör|blir|blev|ger|anges|sägs|framgår|står|fann|ansåg|ogillade|biföll|hindrar|fälls|medför|"
    r"följer|saknar|förutsätter|skulle|bör|borde|döms|dömas|dömde|dömdes|omfattar|omfattas|avser|"
    r"avses|krävs|finner|anser|bedömer|bedömde|avslog|avslår|bifaller|undanröjde|undanröjer|fastställde|"
    r"fastställer|ogillar|ogillas|konstaterade|uttalade|tillåter|hindrade|påför|påförs|påförde|"
    r"påfördes|påföra|föreligger|uppkommer|betalas|upphör|förbjuder|räknas|ersätts|tillämpas|prövas|"
    r"prövade|beviljas|meddelas|träder|finns|fanns|kommer|kom|utgår|utgick|ingår|ingick|bortfaller|"
    r"åligger|utdöma|utdöms|utdömdes|fastställa|bifalla|ogilla|stadgar|stadgas|föreskriver|föreskrivs|"
    r"skiner|heter|menar|påstår|hävdar|visar|gör|gjorde|vet|visste|känner|ser|såg|lämnar|lämnade)(?!\w)|"
    r"(?<!\w)\w{3,}(?:as|ade|ades)(?!\w)",
    re.IGNORECASE | re.UNICODE,
)

# Detect obvious category errors
CATEGORY_ERRORS = [
    # Statute sentencing someone
    re.compile(r"(?:\b\d+\s*§|\blagen\b|\bbalken\b|\bavtalslagen\b|\bhandelsbalken\b|\bbrottsbalken\b|\bskadeståndslagen\b).*(?:dömde|dömer|dömt|dömd|fällde|fällt)\s+.*\s+(?:till\s+fängelse|till\s+böter|till\s+påföljd)", re.IGNORECASE),
    # Equating a court to a crime
    re.compile(r"(?:tingsrätten|hovrätten|högsta\s+domstolen|hd|hfd)\s+är\s+ett?\s+(?:mord|dråp|brott|stöld)", re.IGNORECASE),
    # Self-replacing damage absurdity
    re.compile(r"personskada\s+som\s+ska\s+ersätta\s+sig\s+själv", re.IGNORECASE),
]

# Thresholds calibrated for mDeBERTa-v3-base XNLI on Swedish legal text
DEFAULT_THRESHOLDS = {
    "supported": 0.90,
    "contradiction": 0.90,
    "conflict": 0.70,
    "neutral": 0.80,
}

def check_assessable(claim: str) -> tuple[bool, str | None]:
    """
    Checks if a claim is linguistically and semantically assessable.
    Returns (is_assessable, reason_if_not).
    """
    clean = claim.strip()
    if not clean:
        return False, "Påståendet är tomt eller saknar text."

    if re.search(r"<[^>]+>|\uFFFD", clean):
        return False, "Påståendet innehåller text som inte kunde läsas säkert."

    words = re.findall(r"\b\w{2,}\b", clean)
    if len(words) < 3 or not VERB_PATTERN.search(clean):
        return False, "Inget avgränsat påstående kunde skiljas från texten (ordlista eller saknar verb)."

    for cat_re in CATEGORY_ERRORS:
        if cat_re.search(clean):
            return False, "Påståendet saknar juridisk mening eller innehåller uppenbara kategorifel."

    return True, None


def evaluate_semantic(
    claim: str,
    sources: list[str],
    predict_fn: Any,
    thresholds: dict[str, float] | None = None,
) -> dict[str, Any]:
    """
    Evaluates a claim against an array of source strings.
    predict_fn takes a list of (source, claim) pairs and returns a list of score dicts:
    {"entailment": float, "neutral": float, "contradiction": float}
    """
    t = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    clean_claim = claim.strip()

    is_assessable, reject_reason = check_assessable(clean_claim)
    if not is_assessable:
        label = "nonsensical"
        reason = reject_reason or SEMANTIC_LABELS["nonsensical"][1]
        swedish_label, _ = SEMANTIC_LABELS[label]
        return {
            "label": label,
            "status": "nonsensical",
            "swedish_label": swedish_label,
            "reason": reason,
            "evidence": None,
            "comparisons": [],
        }

    clean_sources = [s.strip() for s in sources if s and s.strip()]
    if not clean_sources:
        label = "unsupported"
        swedish_label, _ = SEMANTIC_LABELS[label]
        return {
            "label": label,
            "status": "missing",
            "swedish_label": swedish_label,
            "reason": "Inga källor angavs att jämföra påståendet mot.",
            "evidence": None,
            "comparisons": [],
        }

    pairs = [(src, clean_claim) for src in clean_sources]
    all_scores = predict_fn(pairs)

    comparisons = []
    for src, scores in zip(clean_sources, all_scores):
        comparisons.append({
            "source": src,
            "scores": scores,
        })

    support = max(comparisons, key=lambda c: c["scores"]["entailment"])
    conflict = max(comparisons, key=lambda c: c["scores"]["contradiction"])

    strong_support = support["scores"]["entailment"] >= t["supported"]
    strong_conflict = conflict["scores"]["contradiction"] >= t["contradiction"]

    # Conflict rule: strong signal blocked if another passage provides significant contradictory signal
    if (strong_support and conflict["scores"]["contradiction"] >= t["conflict"]) or \
       (strong_conflict and support["scores"]["entailment"] >= t["conflict"]):
        label = "abstain"
        status = "abstain"
        reason = "Källavsnitten ger motstridiga signaler. Det går inte att avgöra om ett villkor saknas eller om modellen misstolkar texten."
        evidence = support
    elif strong_support:
        label = "correct"
        status = "correct"
        reason = SEMANTIC_LABELS["correct"][1]
        evidence = support
    elif strong_conflict:
        label = "incorrect"
        status = "incorrect"
        reason = SEMANTIC_LABELS["incorrect"][1]
        evidence = conflict
    elif all(c["scores"]["neutral"] >= t["neutral"] for c in comparisons) or \
         (support["scores"]["entailment"] < 0.40 and conflict["scores"]["contradiction"] < 0.40):
        label = "unsupported"
        status = "missing"
        reason = SEMANTIC_LABELS["unsupported"][1]
        evidence = max(comparisons, key=lambda c: c["scores"]["neutral"])
    else:
        label = "abstain"
        status = "abstain"
        reason = SEMANTIC_LABELS["abstain"][1]
        evidence = support if support["scores"]["entailment"] >= conflict["scores"]["contradiction"] else conflict

    swedish_label, _ = SEMANTIC_LABELS[label]
    return {
        "label": label,
        "status": status,
        "swedish_label": swedish_label,
        "reason": reason,
        "evidence": evidence,
        "comparisons": comparisons,
    }
