from scripts.repair_dataset import citation_for_unit, is_stub


def test_prop_page_names_supplied_page():
    assert citation_for_unit("prop. 2015/16:125 s. 67", "prop/2015/16:125#sid68", "prop_page") == "prop. 2015/16:125 s. 68"
    assert citation_for_unit("a. prop. s. 13 f", "prop/2014/15:96#sid14", "prop_page") == "a. prop. s. 14"


def test_case_pinpoint_names_supplied_point():
    assert citation_for_unit("NJA 2011 s. 638 p. 16", "dom/nja/2011s638#p17", "case_pinpoint") == "NJA 2011 s. 638 p. 17"
    assert citation_for_unit("NJA 2021 s. 377 p. 18 med där gjorda hänvisningar", "dom/nja/2021s377#p19", "case_pinpoint").startswith("NJA 2021 s. 377 p. 19")


def test_statute_keeps_act_name_and_replaces_number():
    assert citation_for_unit("20 § köplagen", "1990:931#P21", "statute_provision") == "21 § köplagen"
    assert citation_for_unit("3 § första stycket", "2014:836#P4", "statute_provision") == "4 § (2014:836)"
    assert citation_for_unit("2 §§", "2008:486#P3", "statute_provision") == "3 § (2008:486)"


def test_cjeu_pinpoint_uses_case_number():
    assert citation_for_unit("C-265/00 , Biomild, EU:C:2004:87, punkt 38", "celex/62000CJ0265#p39", "cjeu_pinpoint") == "C-265/00, Biomild, punkt 39"


def test_stub_detection():
    assert is_stub({"unit_type": "cjeu_assessment", "text": "Prövning av tolkningsfrågorna"})
    assert is_stub({"unit_type": "cjeu_assessment", "text": "I mål C-39/97, angående en begäran " + "x" * 800})
    assert not is_stub({"unit_type": "cjeu_assessment", "text": "Domstolens bedömning " + "y" * 800})
    assert not is_stub({"unit_type": "statute_provision", "text": "4 § Kort text."})
