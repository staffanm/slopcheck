import unittest

import numpy as np

from backend.calibration import DISABLED_THRESHOLD, select_fail_closed_thresholds, selective_metrics


CLASSES = ["supported", "unsupported"]
TARGETS = {"supported": 0.90, "unsupported": 0.90}


class FailClosedCalibrationTests(unittest.TestCase):
    def test_disables_class_when_precision_target_is_unattainable(self):
        probs = np.array([[0.90, 0.10], [0.80, 0.20], [0.70, 0.30]])
        targets = np.array([0, 1, 1])

        result = select_fail_closed_thresholds(
            probs, targets, CLASSES, TARGETS, minimum_accepted=2, use_wilson_lower_bound=False
        )

        self.assertEqual(result["thresholds"]["supported"], DISABLED_THRESHOLD)
        self.assertFalse(result["class_metrics"]["supported"]["enabled"])
        self.assertEqual(result["selective_metrics"]["accepted"], 0)

    def test_requires_minimum_evidence_even_for_perfect_predictions(self):
        probs = np.array([[0.95, 0.05]])
        targets = np.array([0])

        result = select_fail_closed_thresholds(
            probs, targets, CLASSES, TARGETS, minimum_accepted=2, use_wilson_lower_bound=False
        )

        self.assertEqual(result["thresholds"]["supported"], DISABLED_THRESHOLD)
        self.assertEqual(result["class_metrics"]["supported"]["failure_reason"], "insufficient_accepted_examples")

    def test_wilson_bound_can_be_required_or_explicitly_disabled(self):
        probs = np.array([[0.80, 0.20]] * 10)
        targets = np.array([0] * 9 + [1])

        bounded = select_fail_closed_thresholds(probs, targets, CLASSES, TARGETS, minimum_accepted=10)
        unbounded = select_fail_closed_thresholds(
            probs, targets, CLASSES, TARGETS, minimum_accepted=10, use_wilson_lower_bound=False
        )

        self.assertEqual(bounded["thresholds"]["supported"], DISABLED_THRESHOLD)
        self.assertLess(bounded["class_metrics"]["supported"]["wilson_lower_bound"], 0.90)
        self.assertEqual(unbounded["thresholds"]["supported"], 0.80)
        self.assertTrue(unbounded["class_metrics"]["supported"]["enabled"])

    def test_metrics_respect_disabled_threshold(self):
        probs = np.array([[0.99, 0.01], [0.02, 0.98]])
        targets = np.array([0, 1])
        metrics = selective_metrics(
            probs, targets, CLASSES,
            {"supported": DISABLED_THRESHOLD, "unsupported": 0.90}, minimum_margin=0.0,
        )
        self.assertEqual(metrics["accepted"], 1)
        self.assertEqual(metrics["per_class"]["supported"]["accepted"], 0)
        self.assertEqual(metrics["precision_on_accepted"], 1.0)


if __name__ == "__main__":
    unittest.main()


def test_wilson_slack_enables_class_and_failure_reason_names_precision():
    rng = np.random.default_rng(0)
    # 40 confident, all-correct predictions of class 0: precision 1.0, Wilson lower bound 0.912.
    probs = np.tile([0.97, 0.01, 0.01, 0.01], (40, 1))
    targets = np.zeros(40, dtype=int)
    strict = select_fail_closed_thresholds(probs, targets, CLASSES, {c: 0.95 for c in CLASSES}, minimum_accepted=30)
    assert strict["class_metrics"]["supported"]["enabled"] is False
    assert strict["class_metrics"]["supported"]["failure_reason"] == "wilson_bound_unmet"
    relaxed = select_fail_closed_thresholds(probs, targets, CLASSES, {c: 0.95 for c in CLASSES}, minimum_accepted=30, wilson_slack=0.05)
    assert relaxed["class_metrics"]["supported"]["enabled"] is True
    # 40 confident predictions of class 1 with 10 wrong: the blocker is precision, not evidence.
    probs = np.tile([0.01, 0.97, 0.01, 0.01], (40, 1))
    targets = np.array([1] * 30 + [0] * 10)
    result = select_fail_closed_thresholds(probs, targets, CLASSES, {c: 0.95 for c in CLASSES}, minimum_accepted=30)
    assert result["class_metrics"]["unsupported"]["failure_reason"] == "precision_target_unmet"
    del rng
