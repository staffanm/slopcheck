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

    def test_source_not_found(self):
        res = self.resolver.resolve("https://lagen.nu/dom/nja/9999s9999")
        self.assertEqual(res["status"], "abstain")
        self.assertEqual(res["abstain_reason"], "source_not_found")

if __name__ == "__main__":
    unittest.main()
