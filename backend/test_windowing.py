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
