import unittest
from pathlib import Path
from backend.resolver import CitedUnitResolver

class TestCitedUnitResolver(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.resolver = CitedUnitResolver()

    def test_statute_paragraph(self):
        res = self.resolver.resolve("https://lagen.nu/1915:218#P36")
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["unit_type"], "statute_provision")
        self.assertIn("Avtalsvillkor får jämkas", res["text"])
        self.assertIn("konsument", res["text"])

    def test_statute_stycke(self):
        res = self.resolver.resolve("https://lagen.nu/1915:218#P36S1")
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["unit_type"], "statute_stycke")
        self.assertIn("Avtalsvillkor får jämkas", res["text"])
        self.assertNotIn("konsument", res["text"])  # "konsument" is in 2 st

    def test_statute_unbounded(self):
        res = self.resolver.resolve("https://lagen.nu/1915:218")
        self.assertEqual(res["status"], "abstain")
        self.assertEqual(res["abstain_reason"], "unit_unbounded")

        res_chap = self.resolver.resolve("https://lagen.nu/1915:218#K1")
        self.assertEqual(res_chap["status"], "abstain")
        self.assertEqual(res_chap["abstain_reason"], "unit_unbounded")

    def test_statute_pinpoint_not_found(self):
        res = self.resolver.resolve("https://lagen.nu/1915:218#P9999")
        self.assertEqual(res["status"], "abstain")
        self.assertEqual(res["abstain_reason"], "pinpoint_not_found")

    def test_proposition_page(self):
        res = self.resolver.resolve("https://lagen.nu/prop/2008/09:232#sid25")
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["unit_type"], "prop_page")
        self.assertIn("Vid merparten av förordnanden", res["text"])

    def test_proposition_unbounded(self):
        res = self.resolver.resolve("https://lagen.nu/prop/2008/09:232")
        self.assertEqual(res["status"], "abstain")
        self.assertEqual(res["abstain_reason"], "unit_unbounded")

    def test_judgment_pinpoint(self):
        res = self.resolver.resolve("https://lagen.nu/dom/nja/2019s271#p7")
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["unit_type"], "case_pinpoint")
        self.assertIn("Syftet med ett förhandsbesked", res["text"])

    def test_judgment_blanket(self):
        res = self.resolver.resolve("https://lagen.nu/dom/nja/2019s271")
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["unit_type"], "case_judgment")
        # Headnote text from node 0/1 shouldn't be at start
        self.assertTrue(res["text"].startswith("HD (justitieråden"))
        self.assertIn("HD:S AVGÖRANDE", res["text"])

    def test_cjeu_pinpoint(self):
        res = self.resolver.resolve("https://lagen.nu/celex/61987CJ0094#p5")
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["unit_type"], "cjeu_pinpoint")
        self.assertIn("Federal Republic of Germany", res["text"])

    def test_judgment_pinpoint_from_citation_text(self):
        # The extractor drops "p. 26" from the uri (ferenda#112); the citation carries it.
        res = self.resolver.resolve("https://lagen.nu/dom/nja/2022s522", citation="NJA 2022 s. 522 p. 26")
        self.assertEqual(res["unit_type"], "case_pinpoint")
        self.assertEqual(res["source_id"], "https://lagen.nu/dom/nja/2022s522#p26")
        self.assertTrue(res["text"].startswith("26. Det följer av det anförda"))

    def test_proposition_following_page(self):
        one = self.resolver.resolve("https://lagen.nu/prop/2017/18:77#sid369", citation="prop. 2017/18:77 s. 369")
        two = self.resolver.resolve("https://lagen.nu/prop/2017/18:77#sid369", citation="prop. 2017/18:77 s. 369 f.")
        self.assertEqual(two["source_id"], "https://lagen.nu/prop/2017/18:77#sid369")
        self.assertTrue(two["text"].startswith(one["text"]) and len(two["text"]) > len(one["text"]))

    def test_eu_act_article(self):
        res = self.resolver.resolve("https://lagen.nu/celex/32016R0679#32")
        self.assertEqual(res["unit_type"], "eu_article")
        self.assertTrue(res["text"].startswith("Artikel 32"))
        self.assertNotIn("Artikel 33", res["text"])

    def test_convention_article_in_swedish(self):
        res = self.resolver.resolve("https://lagen.nu/1994:1219#B1A6")
        self.assertEqual(res["status"], "ok")
        self.assertIn("Rätt till en rättvis rättegång", res["text"])

    def test_source_not_found(self):
        res = self.resolver.resolve("https://lagen.nu/dom/nja/9999s9999")
        self.assertEqual(res["status"], "abstain")
        self.assertEqual(res["abstain_reason"], "source_not_found")

if __name__ == "__main__":
    unittest.main()


def test_deciding_dom_nodes_skips_lower_court_and_betankande():
    from backend.resolver import deciding_dom_nodes
    hovr = {"type": "dom", "children": [{"type": "domskal", "children": [{"type": "stycke", "text": "HovR:n anförde i beslut: Skäl."}]}]}
    betankande = {"type": "betankande", "children": [{"type": "domskal", "children": [{"type": "stycke", "ordinal": "7", "text": "Föredraganden föreslog."}]}]}
    hd = {"type": "dom", "children": [{"type": "domskal", "children": [{"type": "stycke", "ordinal": "7", "text": "HD fattade följande beslut."}]}]}
    assert deciding_dom_nodes([hovr, betankande, hd]) == [hd]
    assert deciding_dom_nodes([betankande, hd]) == [hd]


def test_cut_dissent_drops_dissent_and_following_text():
    from backend.resolver import cut_dissent
    text = "Skäl. HD finner att talan ska bifallas.\n\nDomslut. HD bifaller talan.\n\nJustR Lind, med vilken JustR Gregow instämde, var skiljaktig och anförde: Talan borde ogillas.\n\nMer text."
    assert cut_dissent(text) == "Skäl. HD finner att talan ska bifallas.\n\nDomslut. HD bifaller talan."
    assert cut_dissent("Skäl. Hovrätten, som var skiljaktig i frågan, ansåg annat.") == "Skäl. Hovrätten, som var skiljaktig i frågan, ansåg annat."



def test_markdown_text_removes_links_and_marks():
    from backend.resolver import markdown_text
    md = "## [Artikel 6](https://lagen.nu/coe/005#A6)\n\n**36 §** Avtalsvillkor får [jämkas](https://lagen.nu/x) \\- se _prop._\n\n> citat"
    assert markdown_text(md) == "Artikel 6\n\n36 § Avtalsvillkor får jämkas - se prop.\n\ncitat"


def test_paragraph_range():
    from backend.resolver import paragraph_range
    assert paragraph_range("NJA 2022 s. 522 p. 26", "") == [26]
    assert paragraph_range("NJA 2019 s. 271 punkterna 7–9", "") == [7, 8, 9]
    assert paragraph_range("", "p12") == [12]
    assert paragraph_range("", "point-60") == [60]
    assert paragraph_range("Mål C-128/11, p. 42, 45", "", cjeu=True) == [42, 45]
    assert paragraph_range("NJA 2019 s. 271 p. 7 och 9", "") == [7, 9]
    assert paragraph_range("", "p7-9") == [7, 8, 9]
    assert paragraph_range("NJA 2005 s. 608", "") == []
