#!/usr/bin/env python3
"""Distils the served KB-BERT classifier into a student small enough for the browser.

The student keeps KB-BERT's width and tokenizer, but:
- only the vocabulary that legal Swedish uses (tokens seen at least --min-token-count times in
  data/ and the fixture sources, plus every single-character piece, so a dropped word still
  tokenizes into shorter pieces);
- --layers of the teacher's 12 encoder layers, evenly spaced, initialised from the teacher.

Training runs the teacher next to the student on the same windowed input and minimises
alpha * KL(teacher || student at temperature T) * T^2 + (1 - alpha) * class-weighted cross entropy
against the (relabelled) gold labels.

    python scripts/distill_kb_bert.py --teacher-dir models/classifier-kb-bert-4way-v5 \
        --layers 4 --min-token-count 2 --output-dir models/classifier-kb-bert-4way-student-l4

With --init-dir the student is cut down from that model instead of the teacher, so a large
teacher with another tokenizer can teach a KB-BERT student (for example --teacher-dir
models/classifier-megatron-large-4way-v1 --init-dir models/classifier-kb-bert-4way-v6).

With --student-model the student is that model instead (for example alexandrainst/scandi-nli-small)
with its own tokenizer and a new four-label head; --layers and --min-token-count do not apply.
"""

import argparse
import copy
import json
import math
import random
import subprocess
import time
from collections import Counter
from pathlib import Path

import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader
from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

from scripts.train_kb_bert import ID2LABEL, LABEL2ID, WindowedLegalDataset, evaluate

CORPUS = ["data/train.audited.jsonl", "data/validation.audited.jsonl", "data/calibration.audited.jsonl",
          "data/test.audited.jsonl", "data/train.rewrites.jsonl", "data/train.neighbours.jsonl",
          "data/train.chunks.jsonl", "data/validation.chunks.jsonl"]


def token_counts(tokenizer) -> Counter:
    texts = set()
    for path in CORPUS:
        for line in open(path, encoding="utf-8"):
            row = json.loads(line)
            texts.add(row["claim"])
            for source in row["sources"]:
                texts.add(source["text"])
                texts.add(source.get("citation") or "")
    for path in Path("test/fixtures/legal-sources").glob("*.md"):
        texts.add(path.read_text(encoding="utf-8"))
    counts = Counter()
    for text in texts:
        counts.update(tokenizer(text, add_special_tokens=False)["input_ids"])
    return counts


def pruned_tokenizer(teacher_dir: Path, min_count: int, out_dir: Path):
    """Writes a WordPiece tokenizer with the kept vocabulary to out_dir and returns it with the
    teacher ids of its tokens, in the new id order. Kept tokens keep their relative order, so
    the special tokens (ids 0-4) keep their ids."""
    teacher_tok = AutoTokenizer.from_pretrained(str(teacher_dir))
    counts = token_counts(teacher_tok)
    spec = json.loads((teacher_dir / "tokenizer.json").read_text(encoding="utf-8"))
    vocab = spec["model"]["vocab"]
    special = {token["id"] for token in spec["added_tokens"]}
    keep = sorted(i for token, i in vocab.items()
                  if i in special or counts.get(i, 0) >= min_count or len(token) == 1 or (token.startswith("##") and len(token) == 3))
    by_id = {i: token for token, i in vocab.items()}
    spec["model"]["vocab"] = {by_id[old]: new for new, old in enumerate(keep)}
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "tokenizer.json").write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
    config = json.loads((teacher_dir / "tokenizer_config.json").read_text(encoding="utf-8"))
    config.pop("added_tokens_decoder", None)
    (out_dir / "tokenizer_config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    tokenizer = AutoTokenizer.from_pretrained(str(out_dir))
    assert "token_type_ids" in tokenizer("a", "b")
    assert [tokenizer.convert_tokens_to_ids(t) for t in ["[PAD]", "[UNK]", "[CLS]", "[SEP]"]] == [0, 1, 2, 3]
    return tokenizer, keep


def student_model(teacher, keep: list[int], layers: int):
    config = copy.deepcopy(teacher.config)
    config.num_hidden_layers = layers
    config.vocab_size = len(keep)
    student = type(teacher)(config)
    picked = [round(i * (teacher.config.num_hidden_layers - 1) / max(layers - 1, 1)) for i in range(layers)]
    state = teacher.state_dict()
    new_state = {}
    for name, tensor in state.items():
        if name == "bert.embeddings.word_embeddings.weight":
            new_state[name] = tensor[keep].clone()
        elif name.startswith("bert.encoder.layer."):
            index = int(name.split(".")[3])
            if index in picked:
                new_state[name.replace(f"layer.{index}.", f"layer.{picked.index(index)}.", 1)] = tensor.clone()
        else:
            new_state[name] = tensor.clone()
    missing, unexpected = student.load_state_dict(new_state, strict=False)
    assert not unexpected and all("position_ids" in m for m in missing), (missing, unexpected)
    return student, picked


class PairCollate:
    """Tokenizes each batch twice: with the teacher's tokenizer and the student's."""

    def __init__(self, teacher_tok, student_tok):
        self.teacher_tok, self.student_tok = teacher_tok, student_tok

    def __call__(self, batch):
        premises = [item["premise"] for item in batch]
        claims = [item["hypothesis"] for item in batch]
        labels = torch.tensor([item["label"] for item in batch], dtype=torch.long)
        encode = lambda tok: tok(premises, claims, padding=True, truncation=True, max_length=512, return_tensors="pt")
        return {"teacher": encode(self.teacher_tok), "student": encode(self.student_tok), "labels": labels}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--teacher-dir", type=Path, default=Path("models/classifier-kb-bert-4way-v5"))
    parser.add_argument("--train-data", default="data/train.chunks.jsonl")
    parser.add_argument("--val-data", default="data/validation.chunks.jsonl")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--init-dir", type=Path, default=None, help="Cut the student down from this model (default: the teacher).")
    parser.add_argument("--student-model", default=None, help="Distil into this model instead of a cut-down teacher.")
    parser.add_argument("--layers", type=int, default=4)
    parser.add_argument("--min-token-count", type=int, default=2)
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--lr", type=float, default=5e-5)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--alpha", type=float, default=0.5, help="Weight of the distillation loss.")
    parser.add_argument("--temperature", type=float, default=2.0)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    random.seed(args.seed)
    device = torch.device("cuda")
    teacher_tok = AutoTokenizer.from_pretrained(str(args.teacher_dir))
    teacher = AutoModelForSequenceClassification.from_pretrained(str(args.teacher_dir)).to(device).eval()
    if args.student_model:
        student_tok = AutoTokenizer.from_pretrained(args.student_model)
        student = AutoModelForSequenceClassification.from_pretrained(
            args.student_model, num_labels=4, id2label=ID2LABEL, label2id=LABEL2ID, ignore_mismatched_sizes=True)
        picked, keep = args.student_model, list(range(student_tok.vocab_size))
    else:
        init_dir = args.init_dir or args.teacher_dir
        init = teacher if init_dir == args.teacher_dir else AutoModelForSequenceClassification.from_pretrained(str(init_dir))
        student_tok, keep = pruned_tokenizer(init_dir, args.min_token_count, args.output_dir)
        student, picked = student_model(init, keep, args.layers)
    student.to(device)
    params = sum(p.numel() for p in student.parameters())
    print(f"Student: {picked}, vocabulary {len(keep)}, {params / 1e6:.1f} M parameters")

    # Windows are cut to the student's token budget: the student is what will run.
    train = WindowedLegalDataset(args.train_data, tokenizer=student_tok, augment_headers=True)
    val = WindowedLegalDataset(args.val_data, tokenizer=student_tok)
    collate = PairCollate(teacher_tok, student_tok)
    train_loader = DataLoader(train, batch_size=args.batch_size, shuffle=True, collate_fn=collate)
    val_loader = DataLoader(val, batch_size=args.batch_size, collate_fn=lambda b: {**collate(b)["student"], "labels": collate(b)["labels"]})

    counts = Counter(example["label"] for example in train.examples)
    weights = torch.tensor([max(counts.values()) / max(counts.get(i, 1), 1) for i in range(4)], device=device)
    ce = torch.nn.CrossEntropyLoss(weight=weights)
    optimizer = torch.optim.AdamW(student.parameters(), lr=args.lr, weight_decay=0.01)
    total = len(train_loader) * args.epochs
    scheduler = get_linear_schedule_with_warmup(optimizer, int(total * 0.06), total)

    best = 0.0
    for epoch in range(1, args.epochs + 1):
        student.train()
        start = time.time()
        for step, batch in enumerate(train_loader, 1):
            labels = batch["labels"].to(device)
            with torch.no_grad(), torch.amp.autocast("cuda", dtype=torch.bfloat16):
                teacher_logits = teacher(**{k: v.to(device) for k, v in batch["teacher"].items()}).logits.float()
            with torch.amp.autocast("cuda", dtype=torch.bfloat16):
                logits = student(**{k: v.to(device) for k, v in batch["student"].items()}).logits.float()
            t = args.temperature
            kd = F.kl_div(F.log_softmax(logits / t, -1), F.softmax(teacher_logits / t, -1), reduction="batchmean") * t * t
            loss = args.alpha * kd + (1 - args.alpha) * ce(logits, labels)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(student.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            optimizer.zero_grad()
            if step % 100 == 0:
                print(f"epoch {epoch} step {step}/{len(train_loader)} loss {loss.item():.4f} kd {kd.item():.4f}", flush=True)
        metrics = evaluate(student, val_loader, device)
        print(f"epoch {epoch}: val accuracy {metrics['accuracy']:.4f}, macro F1 {metrics['macro_f1']:.4f} ({time.time() - start:.0f} s)", flush=True)
        if metrics["macro_f1"] > best:
            best = metrics["macro_f1"]
            student.save_pretrained(args.output_dir)
            student_tok.save_pretrained(args.output_dir)
            (args.output_dir / "training_metadata.json").write_text(json.dumps({
                "teacher": str(args.teacher_dir), "git_commit": subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip(),
                "layers": picked, "vocabulary": len(keep), "min_token_count": args.min_token_count, "parameters": params,
                "alpha": args.alpha, "temperature": args.temperature, "lr": args.lr, "epochs": args.epochs,
                "best_epoch": epoch, "best_macro_f1": best, "val_accuracy": metrics["accuracy"],
                "train_rows": len(train), "train_label_counts": {ID2LABEL[i]: counts.get(i, 0) for i in range(4)},
                "id2label": ID2LABEL, "label2id": LABEL2ID,
            }, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"--> saved (macro F1 {best:.4f})", flush=True)


if __name__ == "__main__":
    main()
