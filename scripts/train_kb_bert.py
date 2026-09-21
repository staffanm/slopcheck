#!/usr/bin/env python3
"""
Fine-tunes KB/bert-base-swedish-cased as a 4-way source-grounded legal claim classifier
with BM25 paragraph windowing for 512-token context.
Labels: 0: supported, 1: unsupported, 2: incorrect, 3: misleading.
"""

import argparse
import json
import math
import os
import random
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, Optional

import torch
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

from backend.windowing import window_premise

LABEL2ID = {
    "supported": 0,
    "unsupported": 1,
    "incorrect": 2,
    "misleading": 3
}
ID2LABEL = {v: k for k, v in LABEL2ID.items()}


UNIT_TYPE_NAMES = {
    "statute_provision": "lagrum",
    "statute_stycke": "lagrum",
    "prop_page": "proposition",
    "case_judgment": "rättsfall",
    "case_pinpoint": "rättsfall",
    "cjeu_assessment": "EU-dom",
    "cjeu_pinpoint": "EU-dom",
}


def header_variants(sources: list[dict]) -> list[list[dict]]:
    """Three header forms the server can receive: the citation as written, the
    unit type only, and the generic fallback the client sends when it has no
    citation. Training on all three stops the header string from carrying label
    information."""
    as_written = sources
    by_type = [dict(s, citation=UNIT_TYPE_NAMES.get(s.get("unit_type", ""), "källa")) for s in sources]
    generic = [dict(s, citation=f"Källa {i + 1}") for i, s in enumerate(sources)]
    return [as_written, by_type, generic]


class WindowedLegalDataset(Dataset):
    def __init__(self, data_path: Path | str, tokenizer: Any, max_premise_tokens: int = 380, augment_headers: bool = False):
        self.examples = []
        self.augment_headers = augment_headers
        with open(data_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                sources = row.get("sources") or ([row["source"]] if "source" in row else [])
                claim = row["claim"]
                variants = header_variants(sources) if augment_headers else [sources]
                premises = [window_premise(claim, v, max_premise_tokens=max_premise_tokens, tokenizer=tokenizer) for v in variants]
                self.examples.append({
                    "premises": premises,
                    "hypothesis": claim,
                    "label": LABEL2ID[row["label"]],
                    "id": row.get("id", "")
                })

    def __len__(self):
        return len(self.examples)

    def __getitem__(self, idx):
        example = self.examples[idx]
        premise = random.choice(example["premises"]) if self.augment_headers else example["premises"][0]
        return {"premise": premise, "hypothesis": example["hypothesis"], "label": example["label"], "id": example["id"]}


class CollateFn:
    def __init__(self, tokenizer: AutoTokenizer, max_length: int = 512):
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __call__(self, batch):
        premises = [item["premise"] for item in batch]
        hypotheses = [item["hypothesis"] for item in batch]
        labels = torch.tensor([item["label"] for item in batch], dtype=torch.long)

        encodings = self.tokenizer(
            premises,
            hypotheses,
            padding=True,
            truncation=True,
            max_length=self.max_length,
            return_tensors="pt"
        )
        encodings["labels"] = labels
        return encodings


def compute_metrics(preds: list[int], targets: list[int]):
    total = len(targets)
    correct = sum(p == t for p, t in zip(preds, targets))
    accuracy = correct / max(total, 1)

    classes = [0, 1, 2, 3]
    cm = [[0 for _ in classes] for _ in classes]
    for p, t in zip(preds, targets):
        cm[t][p] += 1

    per_class = {}
    f1s = []
    for c in classes:
        tp = cm[c][c]
        fp = sum(cm[r][c] for r in classes if r != c)
        fn = sum(cm[c][col] for col in classes if col != c)
        prec = tp / max(tp + fp, 1)
        rec = tp / max(tp + fn, 1)
        f1 = 2 * prec * rec / max(prec + rec, 1e-8)
        per_class[ID2LABEL[c]] = {
            "precision": prec,
            "recall": rec,
            "f1": f1,
            "support": sum(cm[c])
        }
        f1s.append(f1)

    macro_f1 = sum(f1s) / len(f1s)

    return {
        "accuracy": accuracy,
        "macro_f1": macro_f1,
        "per_class": per_class,
        "confusion_matrix": cm
    }


def evaluate(model, dataloader, device, loss_fct=None):
    model.eval()
    all_preds = []
    all_targets = []
    total_loss = 0.0

    with torch.no_grad():
        for batch in dataloader:
            input_ids = batch["input_ids"].to(device)
            attention_mask = batch["attention_mask"].to(device)
            token_type_ids = batch.get("token_type_ids")
            if token_type_ids is not None:
                token_type_ids = token_type_ids.to(device)
            labels = batch["labels"].to(device)

            with torch.amp.autocast(device_type=device.type, dtype=torch.bfloat16, enabled=device.type == "cuda"):
                outputs = model(input_ids=input_ids, attention_mask=attention_mask, token_type_ids=token_type_ids)
                logits = outputs.logits
                loss = loss_fct(logits, labels) if loss_fct is not None else torch.tensor(0.0)

            total_loss += loss.item() * len(labels)
            preds = torch.argmax(logits, dim=-1).cpu().tolist()
            all_preds.extend(preds)
            all_targets.extend(labels.cpu().tolist())

    metrics = compute_metrics(all_preds, all_targets)
    metrics["loss"] = total_loss / max(len(all_targets), 1)
    return metrics


def main():
    parser = argparse.ArgumentParser(description="Fine-tune KB/bert-base-swedish-cased for claim classification.")
    parser.add_argument("--model-name", type=str, default="KB/bert-base-swedish-cased")
    parser.add_argument("--train-data", type=str, default="data/train.jsonl")
    parser.add_argument("--val-data", type=str, default="data/validation.jsonl")
    parser.add_argument("--output-dir", type=str, default="models/classifier-kb-bert-4way")
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--lr", type=float, default=2e-5)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--grad-accum", type=int, default=2)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--warmup-ratio", type=float, default=0.06)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--no-header-augmentation", action="store_true",
                        help="Train only on the citation header, not also on unit-type and generic headers.")
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    random.seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using device: {device}")
    if device.type == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}, VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading tokenizer {args.model_name}...")
    tokenizer = AutoTokenizer.from_pretrained(args.model_name)

    print(f"Loading base model {args.model_name} with num_labels=4...")
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model_name,
        num_labels=4,
        id2label=ID2LABEL,
        label2id=LABEL2ID
    )
    model.to(device)

    print("Preparing datasets with BM25 paragraph windowing...")
    train_dataset = WindowedLegalDataset(args.train_data, tokenizer=tokenizer, max_premise_tokens=380, augment_headers=not args.no_header_augmentation)
    val_dataset = WindowedLegalDataset(args.val_data, tokenizer=tokenizer, max_premise_tokens=380)
    print(f"Loaded {len(train_dataset)} train rows and {len(val_dataset)} validation rows.")

    collate_fn = CollateFn(tokenizer, max_length=512)
    train_loader = DataLoader(train_dataset, batch_size=args.batch_size, shuffle=True, collate_fn=collate_fn, num_workers=0)
    val_loader = DataLoader(val_dataset, batch_size=args.batch_size, shuffle=False, collate_fn=collate_fn, num_workers=0)

    total_steps = math.ceil(len(train_loader) / args.grad_accum) * args.epochs
    warmup_steps = int(total_steps * args.warmup_ratio)

    effective_batch = args.batch_size * args.grad_accum
    print(f"Batch size: {args.batch_size}, Grad accum: {args.grad_accum} (Effective batch: {effective_batch})")
    print(f"Total optimization steps: {total_steps}, Warmup steps: {warmup_steps}")

    # Inverse-frequency class weights, scaled so the largest class has weight 1
    label_counts = Counter(example["label"] for example in train_dataset.examples)
    weights = [max(label_counts.values()) / max(label_counts.get(i, 1), 1) for i in range(4)]
    print("Class weights:", {ID2LABEL[i]: round(w, 3) for i, w in enumerate(weights)})
    class_weights = torch.tensor(weights, device=device, dtype=torch.float32)
    loss_fct = torch.nn.CrossEntropyLoss(weight=class_weights)

    head_params = [p for n, p in model.named_parameters() if "classifier" in n and p.requires_grad]
    backbone_params = [p for n, p in model.named_parameters() if "classifier" not in n and p.requires_grad]

    optimizer = torch.optim.AdamW([
        {"params": backbone_params, "lr": args.lr},
        {"params": head_params, "lr": args.lr * 5.0}
    ], weight_decay=args.weight_decay)
    scheduler = get_linear_schedule_with_warmup(optimizer, num_warmup_steps=warmup_steps, num_training_steps=total_steps)

    best_macro_f1 = 0.0

    print("\n--- Starting Training ---")
    step = 0
    for epoch in range(1, args.epochs + 1):
        model.train()
        epoch_loss = 0.0
        start_time = time.time()
        optimizer.zero_grad()

        for batch_idx, batch in enumerate(train_loader):
            input_ids = batch["input_ids"].to(device)
            attention_mask = batch["attention_mask"].to(device)
            token_type_ids = batch.get("token_type_ids")
            if token_type_ids is not None:
                token_type_ids = token_type_ids.to(device)
            labels = batch["labels"].to(device)

            with torch.amp.autocast(device_type=device.type, dtype=torch.bfloat16, enabled=device.type == "cuda"):
                outputs = model(input_ids=input_ids, attention_mask=attention_mask, token_type_ids=token_type_ids)
                loss = loss_fct(outputs.logits, labels) / args.grad_accum

            loss.backward()
            epoch_loss += loss.item() * args.grad_accum

            if (batch_idx + 1) % args.grad_accum == 0 or (batch_idx + 1) == len(train_loader):
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad()
                step += 1

                if step % 25 == 0 or step == total_steps:
                    lr_cur = scheduler.get_last_lr()[0]
                    print(f"Epoch {epoch}/{args.epochs} | Step {step}/{total_steps} | Loss: {loss.item()*args.grad_accum:.4f} | LR: {lr_cur:.2e}")

        # Evaluate on validation set
        val_metrics = evaluate(model, val_loader, device, loss_fct)
        elapsed = time.time() - start_time

        print(f"\n=== Epoch {epoch} Validation Results ({elapsed:.1f}s) ===")
        print(f"Val Loss: {val_metrics['loss']:.4f} | Accuracy: {val_metrics['accuracy']*100:.2f}% | Macro F1: {val_metrics['macro_f1']*100:.2f}%")
        print("Per-class performance:")
        for lbl, res in val_metrics["per_class"].items():
            print(f"  {lbl.upper():<12} P: {res['precision']*100:.1f}% | R: {res['recall']*100:.1f}% | F1: {res['f1']*100:.1f}% (N={res['support']})")

        print("Confusion Matrix [rows=true, cols=pred]:")
        labels_ordered = [ID2LABEL[i] for i in range(4)]
        print(f"    {'  '.join([l[:4] for l in labels_ordered])}")
        for i, row in enumerate(val_metrics["confusion_matrix"]):
            print(f"{labels_ordered[i][:4]:<4} {row}")

        # Save best checkpoint
        if val_metrics["macro_f1"] > best_macro_f1:
            best_macro_f1 = val_metrics["macro_f1"]
            print(f"\n--> New best Macro F1: {best_macro_f1*100:.2f}%. Saving checkpoint to {output_dir}...")
            model.save_pretrained(output_dir)
            tokenizer.save_pretrained(output_dir)

            metadata = {
                "base_model": args.model_name,
                "git_commit": subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip(),
                "train_rows": len(train_dataset),
                "train_label_counts": {ID2LABEL[i]: label_counts.get(i, 0) for i in range(4)},
                "header_augmentation": not args.no_header_augmentation,
                "best_epoch": epoch,
                "best_macro_f1": best_macro_f1,
                "val_accuracy": val_metrics["accuracy"],
                "id2label": ID2LABEL,
                "label2id": LABEL2ID,
                "config": {
                    "epochs": args.epochs,
                    "lr": args.lr,
                    "effective_batch_size": effective_batch,
                    "batch_size": args.batch_size,
                    "max_length": 512,
                    "window_max_premise_tokens": 380
                }
            }
            with open(output_dir / "training_metadata.json", "w", encoding="utf-8") as f:
                json.dump(metadata, f, indent=2, ensure_ascii=False)

    print(f"\nTraining complete! Best Macro F1: {best_macro_f1*100:.2f}%. Checkpoint saved at {output_dir}")


if __name__ == "__main__":
    main()
