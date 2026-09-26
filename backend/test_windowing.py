import pytest
from backend.windowing import SimpleBM25, window_premise, tokenize_words


def test_simple_bm25():
    corpus = [
        "Högsta domstolen fann att skadestånd inte skulle utgå på grund av bristande oaktsamhet.",
        "Rätten till återkallelse av fullmakt regleras i 12 § avtalslagen.",
        "Hovrättens domslut beträffande utvisning fastställs av Högsta domstolen."
    ]
    bm25 = SimpleBM25(corpus)
    scores = bm25.score("Var skadestånd oaktsamt?")
    assert scores[0] > scores[1]
    assert scores[0] > scores[2]


def test_window_premise_short():
    sources = [{
        "citation": "1 § avtalslagen",
        "text": "Anbud om slutande av avtal och svar å sådant anbud vare, efter ty här nedan i 2-9 §§ sägs, bindande för den, som avgivit anbudet eller svaret."
    }]
    claim = "Ett anbud är bindande enligt avtalslagen."
    result = window_premise(claim, sources, max_premise_tokens=300)
    assert "[Källa 1: 1 § avtalslagen]" in result
    assert "bindande" in result


def test_window_premise_long():
    long_text = "\n\n".join([
        f"Paragraph {i}: Detta är ett långt stycke om rättegångskostnader i hovrätten med nummer {i}."
        for i in range(20)
    ])
    target_para = "Paragraph 15: Detta är det centrala stycket om godtrosförvärv av lösöre och besittningsövergång."
    long_text_with_target = long_text + "\n\n" + target_para

    sources = [{
        "citation": "NJA 2020 s. 100",
        "text": long_text_with_target
    }]
    claim = "Godtrosförvärv av lösöre förutsätter besittningsövergång."
    result = window_premise(claim, sources, max_premise_tokens=150)
    assert "Paragraph 15" in result
    assert "godtrosförvärv" in result


def test_source_chunks_merge_short_paragraphs_and_keep_headers():
    from backend.windowing import source_chunks

    sources = [
        {"citation": "NJA 2020 s. 1", "text": "Domskäl i målet.\n\n" + "Första stycket handlar om en fråga. " * 6 + "\n\n" + "Andra stycket handlar om en annan fråga. " * 6},
        {"citation": "3 § lagen", "text": "Kort regel som står ensam och är tillräckligt lång för att räknas som ett eget stycke i texten."},
    ]
    chunks = source_chunks(sources)
    assert [c["source_idx"] for c in chunks] == [0, 0, 1]
    assert chunks[0]["text"].startswith("Domskäl i målet.\n\nFörsta stycket")
    assert chunks[0]["premise"].startswith("[Källa 1: NJA 2020 s. 1]\n")
    assert chunks[2]["premise"].startswith("[Källa 2: 3 § lagen]\n")
    assert [c["index"] for c in chunks] == [0, 1, 2]


def test_pool_chunks_lets_one_aligned_chunk_defeat_unsupported():
    import numpy as np
    from backend.model import ClaimClassifier

    probs = np.array([[0.05, 0.9, 0.03, 0.02], [0.8, 0.1, 0.05, 0.05], [0.1, 0.85, 0.03, 0.02]])
    pooled, deciding = ClaimClassifier.pool_chunks(probs)
    assert pooled.argmax() == 0 and deciding[0] == 1 and deciding[1] == 1
    assert abs(pooled.sum() - 1.0) < 1e-9
