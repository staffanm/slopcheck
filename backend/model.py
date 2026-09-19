import os
import torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification

DEFAULT_MODEL = "BalaRajesh1/mmbert-small-nli"

class NLIModel:
    def __init__(self, model_name: str | None = None, num_threads: int | None = None):
        self.model_name = model_name or os.environ.get("MODEL_NAME", DEFAULT_MODEL)
        threads = num_threads or int(os.environ.get("NUM_THREADS", "2"))
        torch.set_num_threads(threads)
        self.tokenizer = None
        self.model = None
        self.id2label = {}
        self.max_length = 8192

    def load(self):
        if self.model is not None:
            return
        self.tokenizer = AutoTokenizer.from_pretrained(self.model_name)
        self.model = AutoModelForSequenceClassification.from_pretrained(self.model_name).eval()
        self.id2label = {int(k): v.lower() for k, v in self.model.config.id2label.items()}
        pos_emb = getattr(self.model.config, "max_position_embeddings", None)
        tok_max = getattr(self.tokenizer, "model_max_length", None)
        if pos_emb and pos_emb > 0:
            self.max_length = min(pos_emb, 8192)
        elif tok_max and tok_max > 0:
            self.max_length = min(tok_max, 8192)
        else:
            self.max_length = 512

    def predict_batch(self, pairs: list[tuple[str, str]]) -> list[dict[str, float]]:
        """
        Takes a list of (premise, hypothesis) pairs and returns probability distributions
        for entailment, neutral, contradiction. Supports up to 8192 tokens.
        """
        if not pairs:
            return []
        self.load()
        premises = [p[0] for p in pairs]
        hypotheses = [p[1] for p in pairs]

        inputs = self.tokenizer(
            premises,
            hypotheses,
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=self.max_length,
        )

        with torch.no_grad():
            outputs = self.model(**inputs)
            probs = torch.softmax(outputs.logits, dim=-1)

        results = []
        for row in probs:
            scores = {self.id2label[i]: float(row[i].item()) for i in range(len(row))}
            results.append(scores)
        return results

    def predict(self, premise: str, hypothesis: str) -> dict[str, float]:
        return self.predict_batch([(premise, hypothesis)])[0]


_global_model: NLIModel | None = None

def get_model() -> NLIModel:
    global _global_model
    if _global_model is None:
        _global_model = NLIModel()
        _global_model.load()
    return _global_model
