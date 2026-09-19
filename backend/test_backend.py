import unittest
from semantic import check_assessable, evaluate_semantic

class TestSemanticBackend(unittest.TestCase):
    def test_assessable_checks(self):
        # Valid claims
        self.assertTrue(check_assessable("Oskäliga avtalsvillkor får jämkas eller lämnas utan avseende.")[0])
        self.assertTrue(check_assessable("En fordran preskriberas tio år efter tillkomsten.")[0])
        self.assertTrue(check_assessable("Den som berövar annan livet döms för mord till fängelse.")[0])

        # Empty / whitespace
        is_ok, reason = check_assessable("")
        self.assertFalse(is_ok)
        self.assertIn("tomt", reason)

        # Word salad / no verbs
        is_ok, reason = check_assessable("anbud antagande senare verkan omständigheter häva")
        self.assertFalse(is_ok)
        self.assertIn("saknar verb", reason)

        # Obvious category errors
        is_ok, reason = check_assessable("4 § avtalslagen dömde anbudsgivaren till fängelse för att svaret kom för sent.")
        self.assertFalse(is_ok)
        self.assertIn("kategorifel", reason)

        is_ok, reason = check_assessable("3 kap. 1 § brottsbalken slog fast att hovrätten är ett mord.")
        self.assertFalse(is_ok)
        self.assertIn("kategorifel", reason)

    def test_evaluate_semantic_labels(self):
        # Mock predict function
        def mock_predict(pairs):
            results = []
            for src, hyp in pairs:
                if "inte jämkas" in hyp:
                    # Contradiction
                    results.append({"entailment": 0.01, "neutral": 0.01, "contradiction": 0.98})
                elif "jämkas" in hyp:
                    # Entailment
                    results.append({"entailment": 0.96, "neutral": 0.03, "contradiction": 0.01})
                elif "Stockholm" in hyp:
                    # Neutral
                    results.append({"entailment": 0.01, "neutral": 0.98, "contradiction": 0.01})
                else:
                    results.append({"entailment": 0.33, "neutral": 0.34, "contradiction": 0.33})
            return results

        # 1. Correct claim
        res = evaluate_semantic(
            claim="Oskäliga avtalsvillkor får jämkas.",
            sources=["36 § Avtalsvillkor som är oskäliga får jämkas eller lämnas utan avseende."],
            predict_fn=mock_predict
        )
        self.assertEqual(res["label"], "correct")
        self.assertEqual(res["status"], "correct")
        self.assertEqual(res["swedish_label"], "Stöd hittat")

        # 2. Incorrect claim (contradiction)
        res = evaluate_semantic(
            claim="Oskäliga avtalsvillkor får inte jämkas.",
            sources=["36 § Avtalsvillkor som är oskäliga får jämkas eller lämnas utan avseende."],
            predict_fn=mock_predict
        )
        self.assertEqual(res["label"], "incorrect")
        self.assertEqual(res["status"], "incorrect")
        self.assertEqual(res["swedish_label"], "Möjlig motsägelse")

        # 3. Unsupported claim (neutral)
        res = evaluate_semantic(
            claim="Sveriges huvudstad är Stockholm och har en kung.",
            sources=["36 § Avtalsvillkor som är oskäliga får jämkas eller lämnas utan avseende."],
            predict_fn=mock_predict
        )
        self.assertEqual(res["label"], "unsupported")
        self.assertEqual(res["status"], "missing")
        self.assertEqual(res["swedish_label"], "Stöd saknas")

        # 4. Nonsensical claim
        res = evaluate_semantic(
            claim="avtal villkor jämka ogiltig förfall",
            sources=["36 § Avtalsvillkor som är oskäliga får jämkas eller lämnas utan avseende."],
            predict_fn=mock_predict
        )
        self.assertEqual(res["label"], "nonsensical")
        self.assertEqual(res["status"], "nonsensical")
        self.assertEqual(res["swedish_label"], "Meningslöst")

        # 5. Empty sources
        res = evaluate_semantic(
            claim="Oskäliga avtalsvillkor får jämkas.",
            sources=[],
            predict_fn=mock_predict
        )
        self.assertEqual(res["label"], "unsupported")
        self.assertEqual(res["status"], "missing")
        self.assertEqual(res["swedish_label"], "Stöd saknas")

    def test_api_endpoints_mock(self):
        from fastapi.testclient import TestClient
        from main import app, get_model

        # Ensure model is initialized or mocked
        model = get_model()
        app.state.model = model

        with TestClient(app) as client:
            # Health check
            resp = client.get("/health")
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["status"], "healthy")

            # Match endpoint
            source = "36 § Avtalsvillkor som är oskäliga får jämkas eller lämnas utan avseende."
            cases = [
                ("Oskäliga avtalsvillkor får jämkas.", "correct"),
                ("Oskäliga avtalsvillkor får aldrig jämkas.", "incorrect"),
                ("Solen skiner i morgon.", "unsupported"),
                ("anbud antagande senare verkan omständigheter häva", "nonsensical"),
            ]
            for claim, exp_label in cases:
                resp = client.post("/api/match", json={"claim": claim, "sources": [source]})
                self.assertEqual(resp.status_code, 200)
                body = resp.json()
                self.assertEqual(body["label"], exp_label, f"For claim '{claim}', expected {exp_label}, got {body['label']}")
                self.assertIn("swedish_label", body)
                self.assertIn("reason", body)
                self.assertIn("comparisons", body)

            # Test long context passage (> 1000 tokens)
            long_source = "Detta är ett viktigt avtalsvillkor och en central rättslig princip i svensk rätt. " * 120
            resp = client.post("/api/match", json={
                "claim": "Avtalsvillkor är viktiga.",
                "sources": [long_source]
            })
            self.assertEqual(resp.status_code, 200)
            body = resp.json()
            self.assertIn(body["label"], ["correct", "unsupported", "abstain"])
            self.assertEqual(len(body["comparisons"]), 1)

if __name__ == "__main__":
    unittest.main()
