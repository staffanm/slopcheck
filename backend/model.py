"""
Production ONNX Runtime inference engine for 4-way Swedish legal claim classifier.
Uses KB/bert-base-swedish-cased fine-tuned and INT8 quantized with BM25 paragraph windowing.
Zero text is logged to comply with privacy requirements.
"""

import json
import logging
import os
from pathlib import Path
from typing import Any, Optional

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

from backend.semantic import check_assessable
from backend.windowing import window_premise

logger = logging.getLogger("slopcheck.classifier")

DEFAULT_MODEL_DIR = Path(__file__).resolve().parents[1] / "models" / "classifier-kb-bert-4way"

LABEL_MAPPING = {
    "supported": {
        "label": "correct",
        "status": "correct",
        "swedish_label": "Stöd hittat",
        "reason": "Källavsnittet tycks stödja påståendet."
    },
    "unsupported": {
        "label": "unsupported",
        "status": "missing",
        "swedish_label": "Stöd saknas",
        "reason": "De jämförda avsnitten gav inget tydligt stöd."
    },
    "incorrect": {
        "label": "incorrect",
        "status": "incorrect",
        "swedish_label": "Möjlig motsägelse",
        "reason": "Källavsnittet kan motsäga påståendet."
    },
    "misleading": {
        "label": "misleading",
        "status": "misleading",
        "swedish_label": "Vilseledande",
        "reason": "Påståendet kan vara överdrivet eller sakna väsentliga förbehåll eller undantag."
    }
}

ID2LABEL = {
    0: "supported",
    1: "unsupported",
    2: "incorrect",
    3: "misleading"
}
LABEL2ID = {v: k for k, v in ID2LABEL.items()}


class ClaimClassifier:
    def __init__(
        self,
        model_dir: Optional[Path | str] = None,
        num_threads: Optional[int] = None
    ):
        self.model_dir = Path(model_dir or os.environ.get("MODEL_DIR", DEFAULT_MODEL_DIR))
        self.num_threads = num_threads or int(os.environ.get("NUM_THREADS", "2"))
        self.session: Optional[ort.InferenceSession] = None
        self.tokenizer = None
        self.temperature = 1.7441
        self.thresholds = {
            "supported": 0.65,
            "unsupported": 0.85,
            "incorrect": 0.50,
            "misleading": 0.75
        }
        self.min_margin = 0.00
        self.model_name = "KB/bert-base-swedish-cased-int8"
        self.model_version = "kb-bert-4way-v1"
        self.max_length = 512

    def load(self):
        if self.session is not None:
            return

        onnx_file = self.model_dir / "model_quantized.onnx"
        if not onnx_file.exists():
            onnx_file = self.model_dir / "model.onnx"
        if not onnx_file.exists():
            raise FileNotFoundError(f"No ONNX model found at {self.model_dir}")

        sess_options = ort.SessionOptions()
        sess_options.intra_op_num_threads = self.num_threads
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(str(onnx_file), sess_options, providers=["CPUExecutionProvider"])

        self.tokenizer = AutoTokenizer.from_pretrained(str(self.model_dir))

        # Load calibration if available
        cal_path = self.model_dir / "calibration.json"
        if cal_path.exists():
            try:
                with open(cal_path, "r", encoding="utf-8") as f:
                    cal_data = json.load(f)
                    self.temperature = float(cal_data.get("temperature", self.temperature))
                    self.min_margin = float(cal_data.get("minimum_margin", self.min_margin))
                    if "thresholds" in cal_data:
                        self.thresholds.update(cal_data["thresholds"])
            except Exception as e:
                logger.warning(f"Could not load calibration config: {e}")

    def predict_claim(
        self,
        claim: str,
        sources: list[dict | str],
        unresolved_sources: Optional[list[str]] = None
    ) -> dict[str, Any]:
        """
        Assesses a single claim against one or more source passages/units.
        Strict privacy: does not log claim or source text.
        """
        unresolved = unresolved_sources or []

        # 1. Structural assessability check
        assessable, reject_reason = check_assessable(claim)
        if not assessable:
            return {
                "label": "nonsensical",
                "status": "nonsensical",
                "swedish_label": "Meningslöst",
                "reason": reject_reason or "Påståendet saknar juridisk innebörd eller kan inte bedömas meningsfullt.",
                "evidence": None,
                "comparisons": [],
                "model": self.model_name,
                "model_version": self.model_version
            }

        # Normalize sources
        norm_sources: list[dict] = []
        for idx, s in enumerate(sources):
            if isinstance(s, dict):
                norm_sources.append({
                    "citation": s.get("citation") or f"Källa {idx + 1}",
                    "text": s.get("text", "").strip(),
                    "unit_type": s.get("unit_type", "unknown")
                })
            elif isinstance(s, str) and s.strip():
                norm_sources.append({
                    "citation": f"Källa {idx + 1}",
                    "text": s.strip(),
                    "unit_type": "unknown"
                })

        norm_sources = [s for s in norm_sources if s["text"]]

        # If no resolved sources available
        if not norm_sources:
            if unresolved:
                return {
                    "label": "abstain",
                    "status": "abstain",
                    "swedish_label": "Kunde inte bedömas",
                    "reason": "Inga angivna källor kunde hämtas eller avgränsas.",
                    "evidence": None,
                    "comparisons": [{
                        "source": "",
                        "scores": {},
                        "confidence": 0.0,
                        "margin": 0.0,
                        "abstain_reason": "unresolved_sources",
                        "token_length": 0,
                        "unresolved_sources": unresolved
                    }],
                    "model": self.model_name,
                    "model_version": self.model_version
                }
            else:
                return {
                    "label": "unsupported",
                    "status": "missing",
                    "swedish_label": "Stöd saknas",
                    "reason": "Inga källor angavs att jämföra påståendet mot.",
                    "evidence": None,
                    "comparisons": [],
                    "model": self.model_name,
                    "model_version": self.model_version
                }

        self.load()

        # 2. BM25 paragraph windowing
        windowed_premise = window_premise(
            claim=claim,
            sources=norm_sources,
            max_premise_tokens=380,
            tokenizer=self.tokenizer
        )

        # 3. Tokenize
        enc = self.tokenizer(
            windowed_premise,
            claim,
            max_length=self.max_length,
            truncation=True,
            return_tensors="np"
        )
        token_length = int(enc["input_ids"].shape[1])

        # Token guard
        if token_length > self.max_length:
            return {
                "label": "abstain",
                "status": "abstain",
                "swedish_label": "Kunde inte bedömas",
                "reason": "Källmaterialet överstiger modellens sammanhangsbudget.",
                "evidence": norm_sources,
                "comparisons": [{
                    "source": windowed_premise,
                    "scores": {},
                    "confidence": 0.0,
                    "margin": 0.0,
                    "abstain_reason": "unit_too_long",
                    "token_length": token_length,
                    "unresolved_sources": unresolved
                }],
                "model": self.model_name,
                "model_version": self.model_version
            }

        ort_inputs = {
            "input_ids": enc["input_ids"].astype(np.int64),
            "attention_mask": enc["attention_mask"].astype(np.int64)
        }
        if "token_type_ids" in enc:
            ort_inputs["token_type_ids"] = enc["token_type_ids"].astype(np.int64)

        # 4. ONNX inference
        raw_logits = self.session.run(None, ort_inputs)[0][0]

        # 5. Temperature scaling & Softmax
        scaled_logits = raw_logits / max(self.temperature, 1e-4)
        max_logit = np.max(scaled_logits)
        exp_logits = np.exp(scaled_logits - max_logit)
        probs = exp_logits / np.sum(exp_logits)

        scores = {ID2LABEL[i]: round(float(probs[i]), 4) for i in range(len(probs))}

        pred_idx = int(np.argmax(probs))
        predicted_class = ID2LABEL[pred_idx]
        confidence = float(probs[pred_idx])

        sorted_probs = np.sort(probs)
        margin = float(sorted_probs[-1] - sorted_probs[-2])

        # 6. Rejection / Abstention logic
        threshold = self.thresholds.get(predicted_class, 0.5)
        is_low_conf = confidence < threshold
        is_low_margin = margin < self.min_margin

        abstain_reason = None
        if is_low_conf:
            abstain_reason = "low_confidence"
        elif is_low_margin:
            abstain_reason = "low_margin"

        # Partly resolved check (Section 9)
        if predicted_class == "unsupported" and unresolved:
            abstain_reason = "partial_sources"

        if abstain_reason is not None:
            label = "abstain"
            status = "abstain"
            swedish_label = "Kunde inte bedömas"
            if abstain_reason == "partial_sources":
                reason = "Källan gav inget stöd, men alla åberopade källor kunde inte avgränsas fullt ut."
            else:
                reason = "Modellens säkerhet är under tröskelvärdet för säker klassificering."
        else:
            mapped = LABEL_MAPPING[predicted_class]
            label = mapped["label"]
            status = mapped["status"]
            swedish_label = mapped["swedish_label"]
            reason = mapped["reason"]

        logger.info(
            f"classified claim: status={status}, label={label}, "
            f"conf={confidence:.3f}, margin={margin:.3f}, len={token_length}"
        )

        evidence_entry = {
            "source": windowed_premise,
            "scores": scores
        }

        comparison_entry = {
            "source": windowed_premise,
            "scores": scores,
            "confidence": round(confidence, 4),
            "margin": round(margin, 4),
            "predicted_class": predicted_class,
            "abstain_reason": abstain_reason,
            "token_length": token_length,
            "unresolved_sources": unresolved
        }

        return {
            "label": label,
            "status": status,
            "swedish_label": swedish_label,
            "reason": reason,
            "evidence": evidence_entry,
            "comparisons": [comparison_entry],
            "model": self.model_name,
            "model_version": self.model_version
        }


_global_classifier: Optional[ClaimClassifier] = None

def get_model() -> ClaimClassifier:
    global _global_classifier
    if _global_classifier is None:
        _global_classifier = ClaimClassifier()
        _global_classifier.load()
    return _global_classifier
