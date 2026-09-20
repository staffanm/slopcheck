"""
Paragraph windowing and relevant excerpt extraction using BM25.
Extracts the most relevant paragraph(s) from resolved source units to fit within
a 512-token context window for Swedish encoders (e.g. KB-BERT).
"""

import math
import re
from collections import Counter
from typing import Any, Optional

from backend.resolver import format_premise


def tokenize_words(text: str) -> list[str]:
    """Tokenizes text into lowercase Swedish words for BM25 ranking."""
    return [w.lower() for w in re.findall(r"\w+", text)]


class SimpleBM25:
    """Fast, dependency-free BM25 implementation for paragraph ranking."""
    def __init__(self, corpus: list[str], k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.corpus_size = len(corpus)
        self.doc_lens = [len(tokenize_words(doc)) for doc in corpus]
        self.avgdl = sum(self.doc_lens) / max(self.corpus_size, 1)
        self.doc_freqs = []
        self.df = Counter()
        for doc in corpus:
            tf = Counter(tokenize_words(doc))
            self.doc_freqs.append(tf)
            for word in tf.keys():
                self.df[word] += 1
        self.idf = {}
        for word, freq in self.df.items():
            self.idf[word] = math.log((self.corpus_size - freq + 0.5) / (freq + 0.5) + 1.0)

    def score(self, query: str) -> list[float]:
        q_words = tokenize_words(query)
        scores = []
        for idx, tf in enumerate(self.doc_freqs):
            dl = self.doc_lens[idx]
            s = 0.0
            for w in q_words:
                if w in tf:
                    count = tf[w]
                    num = count * (self.k1 + 1)
                    denom = count + self.k1 * (1 - self.b + self.b * (dl / max(self.avgdl, 1e-6)))
                    s += self.idf.get(w, 0.0) * (num / denom)
            scores.append(s)
        return scores


def estimate_tokens(text: str) -> int:
    """Rough estimation of token count (~1.3 tokens per word in Swedish BERT)."""
    words = len(re.findall(r"\S+", text))
    return int(words * 1.35) + 5


def window_premise(
    claim: str,
    sources: list[dict],
    max_premise_tokens: int = 380,
    tokenizer: Optional[Any] = None
) -> str:
    """
    Extracts the most relevant paragraph(s) from the provided sources using BM25
    relative to the claim, ensuring the premise fits comfortably within the model's
    context limit (leaving space for the claim and special tokens).

    If the formatted premise is already within `max_premise_tokens`, it is returned unchanged.
    """
    if not sources:
        return ""

    full_premise = format_premise(sources)
    if tokenizer is not None:
        full_len = len(tokenizer.encode(full_premise, add_special_tokens=False))
    else:
        full_len = estimate_tokens(full_premise)

    if full_len <= max_premise_tokens:
        return full_premise

    candidate_chunks = []
    for s_idx, s in enumerate(sources):
        citation = s.get("citation", f"Källa {s_idx + 1}")
        raw_text = s.get("text", "")
        # Split by double newline first; if no double newlines, split by single newline
        paras = [p.strip() for p in raw_text.split("\n\n") if len(p.strip()) > 15]
        if not paras:
            paras = [p.strip() for p in raw_text.split("\n") if len(p.strip()) > 15]
        if not paras:
            paras = [raw_text.strip()] if raw_text.strip() else []

        for p_idx, p in enumerate(paras):
            # If paragraph itself is excessively long (>1200 chars), split into sub-sentences
            if len(p) > 1500:
                sentences = re.split(r"(?<=[.!?])\s+", p)
                sub_chunk = []
                sub_idx = 0
                for sent in sentences:
                    sub_chunk.append(sent)
                    if len(" ".join(sub_chunk)) >= 800:
                        candidate_chunks.append({
                            "source_idx": s_idx,
                            "citation": citation,
                            "p_idx": p_idx * 100 + sub_idx,
                            "text": " ".join(sub_chunk)
                        })
                        sub_chunk = []
                        sub_idx += 1
                if sub_chunk:
                    candidate_chunks.append({
                        "source_idx": s_idx,
                        "citation": citation,
                        "p_idx": p_idx * 100 + sub_idx,
                        "text": " ".join(sub_chunk)
                    })
            else:
                candidate_chunks.append({
                    "source_idx": s_idx,
                    "citation": citation,
                    "p_idx": p_idx,
                    "text": p
                })

    if not candidate_chunks:
        return full_premise[:1200]

    corpus = [c["text"] for c in candidate_chunks]
    bm25 = SimpleBM25(corpus)
    scores = bm25.score(claim)

    ranked_indices = sorted(range(len(candidate_chunks)), key=lambda i: scores[i], reverse=True)

    selected = []
    accum_tokens = 0
    for idx in ranked_indices:
        chunk = candidate_chunks[idx]
        header = f"[Källa {chunk['source_idx'] + 1}: {chunk['citation']}]\n"
        chunk_str = header + chunk["text"]
        if tokenizer is not None:
            c_tokens = len(tokenizer.encode(chunk_str, add_special_tokens=False))
        else:
            c_tokens = estimate_tokens(chunk_str)

        if accum_tokens + c_tokens <= max_premise_tokens or not selected:
            selected.append(chunk)
            accum_tokens += c_tokens
        if accum_tokens >= max_premise_tokens:
            break

    # Sort selected chunks back into original document order
    selected.sort(key=lambda c: (c["source_idx"], c["p_idx"]))

    # Group chunks by source
    grouped = []
    curr_s_idx = None
    curr_parts = []
    curr_header = ""
    for c in selected:
        if c["source_idx"] != curr_s_idx:
            if curr_parts:
                grouped.append(curr_header + "\n\n".join(curr_parts))
            curr_s_idx = c["source_idx"]
            curr_header = f"[Källa {c['source_idx'] + 1}: {c['citation']}]\n"
            curr_parts = [c["text"]]
        else:
            curr_parts.append(c["text"])
    if curr_parts:
        grouped.append(curr_header + "\n\n".join(curr_parts))

    return "\n\n".join(grouped)
