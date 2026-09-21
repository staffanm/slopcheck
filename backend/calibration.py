"""Fail-closed selective-classification calibration utilities.

This module deliberately depends only on NumPy so that threshold selection and
reporting can be tested without loading a model.  A class is enabled only when
the calibration observations accepted for that class meet its requested
precision constraint; otherwise its threshold is set above one.
"""

from __future__ import annotations

import math
from typing import Mapping, Sequence

import numpy as np


DISABLED_THRESHOLD = 1.01


def wilson_lower_bound(correct: int, total: int, z: float = 1.96) -> float:
    """Two-sided Wilson lower confidence bound for a binomial proportion."""
    if total <= 0:
        return 0.0
    proportion = correct / total
    denominator = 1.0 + z * z / total
    centre = proportion + z * z / (2.0 * total)
    spread = z * math.sqrt((proportion * (1.0 - proportion) + z * z / (4.0 * total)) / total)
    return (centre - spread) / denominator


def _prediction_parts(probs: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if probs.ndim != 2 or probs.shape[1] < 2:
        raise ValueError("probs must have shape (examples, at least two classes)")
    predictions = np.argmax(probs, axis=1)
    ordered = np.sort(probs, axis=1)
    confidence = ordered[:, -1]
    margin = confidence - ordered[:, -2]
    return predictions, confidence, margin


def selective_metrics(
    probs: np.ndarray,
    targets: np.ndarray,
    classes: Sequence[str],
    thresholds: Mapping[str, float],
    minimum_margin: float,
) -> dict:
    """Return exact accepted counts and precision for a persisted policy."""
    predictions, confidence, margins = _prediction_parts(probs)
    if len(targets) != len(predictions):
        raise ValueError("targets and probs have different numbers of examples")

    accepted = np.zeros(len(predictions), dtype=bool)
    for index, class_name in enumerate(classes):
        accepted |= (predictions == index) & (confidence >= float(thresholds[class_name])) & (margins >= minimum_margin)

    accepted_count = int(np.sum(accepted))
    correct_count = int(np.sum(predictions[accepted] == targets[accepted]))
    by_class = {}
    for index, class_name in enumerate(classes):
        mask = accepted & (predictions == index)
        count = int(np.sum(mask))
        correct = int(np.sum(targets[mask] == index))
        by_class[class_name] = {
            "enabled": float(thresholds[class_name]) <= 1.0,
            "accepted": count,
            "correct": correct,
            "incorrect": count - correct,
            "precision": (correct / count) if count else None,
        }

    return {
        "total": int(len(predictions)),
        "accepted": accepted_count,
        "abstained": int(len(predictions) - accepted_count),
        "coverage": (accepted_count / len(predictions)) if len(predictions) else 0.0,
        "correct": correct_count,
        "incorrect": accepted_count - correct_count,
        "precision_on_accepted": (correct_count / accepted_count) if accepted_count else None,
        "per_class": by_class,
    }


def select_fail_closed_thresholds(
    probs: np.ndarray,
    targets: np.ndarray,
    classes: Sequence[str],
    target_precisions: Mapping[str, float],
    *,
    minimum_accepted: int = 30,
    use_wilson_lower_bound: bool = True,
    wilson_z: float = 1.96,
    wilson_slack: float = 0.0,
    margin_grid: Sequence[float] = (0.0, 0.05, 0.10, 0.15, 0.20),
) -> dict:
    """Select per-class thresholds and one margin while enforcing every target.

    For each possible margin, each class receives the lowest threshold that
    maximizes its coverage while satisfying the requested precision, minimum
    accepted examples, and optional Wilson lower bound. The Wilson bound must
    reach the target minus ``wilson_slack``; with a few hundred calibration
    rows a bound equal to the target needs dozens of consecutive correct
    acceptances. Classes without such a threshold are disabled instead of
    silently falling back to an unsafe value. The best complete policy is the
    one with the most accepted calibration rows.
    """
    predictions, confidence, margins = _prediction_parts(probs)
    targets = np.asarray(targets)
    if len(targets) != len(predictions):
        raise ValueError("targets and probs have different numbers of examples")
    if minimum_accepted < 1:
        raise ValueError("minimum_accepted must be at least one")
    if not margin_grid:
        raise ValueError("margin_grid cannot be empty")

    best: dict | None = None
    for minimum_margin in sorted(set(float(value) for value in margin_grid)):
        thresholds: dict[str, float] = {}
        class_metrics: dict[str, dict] = {}
        for class_index, class_name in enumerate(classes):
            target = float(target_precisions[class_name])
            class_mask = (predictions == class_index) & (margins >= minimum_margin)
            candidate_scores = sorted(set(float(v) for v in confidence[class_mask]))
            valid: list[tuple[float, int, int, float, float]] = []
            best_observed: tuple[int, int, float, float] | None = None
            for threshold in candidate_scores:
                accepted = class_mask & (confidence >= threshold)
                count = int(np.sum(accepted))
                correct = int(np.sum(targets[accepted] == class_index))
                precision = correct / count
                lower_bound = wilson_lower_bound(correct, count, wilson_z)
                enough_evidence = count >= minimum_accepted
                precision_ok = precision >= target
                bound_ok = not use_wilson_lower_bound or lower_bound >= target - wilson_slack
                # Remember the most precise candidate with enough evidence, so the
                # failure reason names the constraint that actually blocked the class.
                if enough_evidence and (best_observed is None or precision > best_observed[2]):
                    best_observed = (count, correct, precision, lower_bound)
                if enough_evidence and precision_ok and bound_ok:
                    valid.append((threshold, count, correct, precision, lower_bound))

            if valid:
                # Lowest passing threshold has the greatest coverage. Ties are
                # deterministic because candidate_scores are ascending.
                threshold, count, correct, precision, lower_bound = valid[0]
                thresholds[class_name] = threshold
                class_metrics[class_name] = {
                    "enabled": True,
                    "threshold": threshold,
                    "target_precision": target,
                    "accepted": count,
                    "correct": correct,
                    "incorrect": count - correct,
                    "empirical_precision": precision,
                    "wilson_lower_bound": lower_bound,
                    "failure_reason": None,
                }
            else:
                thresholds[class_name] = DISABLED_THRESHOLD
                if not candidate_scores:
                    reason = "no_predictions_at_margin"
                elif best_observed is None:
                    reason = "insufficient_accepted_examples"
                elif best_observed[2] < target:
                    reason = "precision_target_unmet"
                else:
                    reason = "wilson_bound_unmet"
                count, correct, precision, lower_bound = best_observed or (0, 0, 0.0, 0.0)
                class_metrics[class_name] = {
                    "enabled": False,
                    "threshold": DISABLED_THRESHOLD,
                    "target_precision": target,
                    "accepted": count,
                    "correct": correct,
                    "incorrect": count - correct,
                    "empirical_precision": precision if count else None,
                    "wilson_lower_bound": lower_bound if count else None,
                    "failure_reason": reason,
                }

        metrics = selective_metrics(probs, targets, classes, thresholds, minimum_margin)
        candidate = {
            "thresholds": thresholds,
            "minimum_margin": minimum_margin,
            "class_metrics": class_metrics,
            "selective_metrics": metrics,
        }
        if best is None or metrics["accepted"] > best["selective_metrics"]["accepted"]:
            best = candidate

    assert best is not None
    best["constraints"] = {
        "minimum_accepted": minimum_accepted,
        "use_wilson_lower_bound": use_wilson_lower_bound,
        "wilson_z": wilson_z if use_wilson_lower_bound else None,
        "wilson_slack": wilson_slack if use_wilson_lower_bound else None,
        "margin_grid": list(sorted(set(float(value) for value in margin_grid))),
        "disabled_threshold": DISABLED_THRESHOLD,
    }
    return best
