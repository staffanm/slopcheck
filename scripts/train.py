#!/usr/bin/env python3
"""
Fine-tunes BalaRajesh1/mmbert-small-nli as a 4-way source-grounded legal claim classifier.
Labels: 0: supported, 1: unsupported, 2: incorrect, 3: misleading.
Configuration: bf16, sdpa, gradient checkpointing, dynamic length bucketing, 8192 max context.
"""

import argparse
import json
import math
import os
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, Optional

import torch
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

from backend.resolver import format_premise

LABEL2ID = {
    "supported": 0,
    "unsupported": 1,
    "incorrect": 2,
    "misleading": 3
}
ID2LABEL = {v: k for k, v in LABEL2ID.items()}


class LegalClaimDataset(Dataset):
    def __init__(self, data_path: Path | str):
        self.rows = []
        with open(data_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    self.rows.append(json.loads(line))

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, idx):
        row = self.rows[idx]
        sources = row.get("sources") or ([row["source"]] if "source" in row else [])
        premise = format_premise(sources)
        return {
            "premise": premise,
            "hypothesis": row["claim"],
            "label": LABEL2ID[row["label"]],
            "token_length": row.get("token_length", 0),
            "id": row.get("id", "")
        }


class BucketedBatchSampler:
    """
    Groups examples into length buckets and samples batches from within buckets
    to avoid padding short examples to 8192.
    """
    def __init__(self, dataset: LegalClaimDataset, batch_size: int, shuffle: bool = True):
        self.batch_size = batch_size
        self.shuffle = shuffle

        # Group indices by length bucket directly from dataset.rows
        buckets = {
            "<=512": [],
            "513-2048": [],
            "2049-4096": [],
            "4097-8192": []
        }
        for idx, row in enumerate(dataset.rows):
            t_len = row.get("token_length", 0)
            if t_len <= 512:
                buckets["<=512"].append(idx)
            elif t_len <= 2048:
                buckets["513-2048"].append(idx)
            elif t_len <= 4096:
                buckets["2049-4096"].append(idx)
            else:
                buckets["4097-8192"].append(idx)

        self.batches = []
        for bucket_name, indices in buckets.items():
            if not indices:
                continue
            if self.shuffle:
                # Shuffle within bucket
                perm = torch.randperm(len(indices)).tolist()
                indices = [indices[i] for i in perm]
            for i in range(0, len(indices), batch_size):
                self.batches.append(indices[i:i + batch_size])

    def __iter__(self):
        if self.shuffle:
            perm = torch.randperm(len(self.batches)).tolist()
            for idx in perm:
                yield self.batches[idx]
        else:
            for b in self.batches:
                yield b

    def __len__(self):
        return len(self.batches)


def create_collate_fn(tokenizer: AutoTokenizer):
    def collate_fn(batch):
        premises = [item["premise"] for item in batch]
        hypotheses = [item["hypothesis"] for item in batch]
        labels = torch.tensor([item["label"] for item in batch], dtype=torch.long)

        # Dynamic padding to max length in this micro-batch
        encodings = tokenizer(
            premises,
            hypotheses,
            padding=True,
            truncation=True,
            max_length=8192,
            return_tensors="pt"
        )
        encodings["labels"] = labels
        return encodings
    return collate_fn


def compute_metrics(preds: list[int], targets: list[int]):
    """Computes Accuracy, Macro F1, per-class Precision, Recall, F1 and confusion matrix."""
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


def get_git_commit() -> str:
    try:
        res = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True)
        return res.stdout.strip()
    except Exception:
        return "unknown"


def evaluate(model, dataloader, device, loss_fct=None):
    model.eval()
    all_preds = []
    all_targets = []
    total_loss = 0.0

    with torch.no_grad():
        for batch in dataloader:
            input_ids = batch["input_ids"].to(device)
            attention_mask = batch["attention_mask"].to(device)
            labels = batch["labels"].to(device)

            with torch.amp.autocast(device_type="cuda", dtype=torch.bfloat16):
                outputs = model(input_ids=input_ids, attention_mask=attention_mask)
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
    parser = argparse.ArgumentParser(description="Fine-tune mmbert-small-nli for source-grounded claim classification.")
    parser.add_argument("--model-name", type=str, default="BalaRajesh1/mmbert-small-nli")
    parser.add_argument("--train-data", type=str, default="data/train.jsonl")
    parser.add_argument("--val-data", type=str, default="data/validation.jsonl")
    parser.add_argument("--output-dir", type=str, default="models/classifier-mmbert-small-4way")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--lr", type=float, default=2e-5)
    parser.add_argument("--micro-batch-size", type=int, default=2)
    parser.add_argument("--effective-batch-size", type=int, default=32)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--warmup-ratio", type=float, default=0.06)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using device: {device}")
    if device.type == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}, VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading tokenizer {args.model_name}...")
    tokenizer = AutoTokenizer.from_pretrained(args.model_name)

    print(f"Loading pretrained 3-way weights from {args.model_name}...")
    orig_model = AutoModelForSequenceClassification.from_pretrained(args.model_name, dtype=torch.bfloat16)
    orig_w = orig_model.classifier.weight.data.clone()
    orig_b = orig_model.classifier.bias.data.clone()
    del orig_model

    print(f"Loading base model {args.model_name} with num_labels=4...")
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model_name,
        num_labels=4,
        id2label=ID2LABEL,
        label2id=LABEL2ID,
        ignore_mismatched_sizes=True,
        dtype=torch.bfloat16,
        attn_implementation="sdpa"
    )

    # Initialize 4-way classifier from 3-way NLI weights
    # 0: supported <- entailment (0)
    # 1: unsupported <- neutral (1)
    # 2: incorrect <- contradiction (2)
    # 3: misleading <- blend of supported and incorrect
    with torch.no_grad():
        model.classifier.weight.data[0] = orig_w[0]
        model.classifier.weight.data[1] = orig_w[1]
        model.classifier.weight.data[2] = orig_w[2]
        model.classifier.weight.data[3] = 0.5 * (orig_w[0] + orig_w[2])

        model.classifier.bias.data[0] = orig_b[0]
        model.classifier.bias.data[1] = orig_b[1]
        model.classifier.bias.data[2] = orig_b[2]
        model.classifier.bias.data[3] = 0.5 * (orig_b[0] + orig_b[2])

    # Enable gradient checkpointing to handle 8192 context on 24GB VRAM
    model.gradient_checkpointing_enable()
    model.to(device)

    # Load datasets
    train_dataset = LegalClaimDataset(args.train_data)
    val_dataset = LegalClaimDataset(args.val_data)
    print(f"Loaded {len(train_dataset)} train rows and {len(val_dataset)} validation rows.")

    collate_fn = create_collate_fn(tokenizer)
    train_sampler = BucketedBatchSampler(train_dataset, batch_size=args.micro_batch_size, shuffle=True)
    train_loader = DataLoader(train_dataset, batch_sampler=train_sampler, collate_fn=collate_fn)

    val_sampler = BucketedBatchSampler(val_dataset, batch_size=args.micro_batch_size, shuffle=False)
    val_loader = DataLoader(val_dataset, batch_sampler=val_sampler, collate_fn=collate_fn)

    grad_accum_steps = max(1, args.effective_batch_size // args.micro_batch_size)
    total_steps = (len(train_loader) // grad_accum_steps) * args.epochs
    warmup_steps = int(total_steps * args.warmup_ratio)

    print(f"Micro-batch: {args.micro_batch_size}, Grad accum steps: {grad_accum_steps} (Effective batch: {args.effective_batch_size})")
    print(f"Total optimization steps: {total_steps}, Warmup steps: {warmup_steps}")

    # Class-weighted loss to balance supported (2x frequency) with hard negatives
    class_weights = torch.tensor([1.0, 2.0, 2.0, 2.0], device=device, dtype=torch.bfloat16)
    loss_fct = torch.nn.CrossEntropyLoss(weight=class_weights)

    head_params = [p for n, p in model.named_parameters() if ("head" in n or "classifier" in n) and p.requires_grad]
    backbone_params = [p for n, p in model.named_parameters() if ("head" not in n and "classifier" not in n) and p.requires_grad]

    optimizer = torch.optim.AdamW([
        {"params": backbone_params, "lr": args.lr},
        {"params": head_params, "lr": args.lr * 5.0}
    ], weight_decay=args.weight_decay)
    scheduler = get_linear_schedule_with_warmup(optimizer, num_warmup_steps=warmup_steps, num_training_steps=total_steps)

    best_macro_f1 = 0.0
    git_commit = get_git_commit()

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
            labels = batch["labels"].to(device)

            with torch.amp.autocast(device_type="cuda", dtype=torch.bfloat16):
                outputs = model(input_ids=input_ids, attention_mask=attention_mask)
                loss = loss_fct(outputs.logits, labels) / grad_accum_steps

            loss.backward()
            epoch_loss += loss.item() * grad_accum_steps

            if (batch_idx + 1) % grad_accum_steps == 0 or (batch_idx + 1) == len(train_loader):
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad()
                step += 1

                if step % 20 == 0 or step == total_steps:
                    lr_cur = scheduler.get_last_lr()[0]
                    print(f"Epoch {epoch}/{args.epochs} | Step {step}/{total_steps} | Loss: {loss.item()*grad_accum_steps:.4f} | LR: {lr_cur:.2e}")

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

        # Save best model checkpoint
        if val_metrics["macro_f1"] > best_macro_f1:
            best_macro_f1 = val_metrics["macro_f1"]
            print(f"\n--> New best Macro F1: {best_macro_f1*100:.2f}%. Saving checkpoint to {output_dir}...")
            model.save_pretrained(output_dir)
            tokenizer.save_pretrained(output_dir)

            metadata = {
                "base_model": args.model_name,
                "git_commit": git_commit,
                "best_epoch": epoch,
                "best_macro_f1": best_macro_f1,
                "val_accuracy": val_metrics["accuracy"],
                "id2label": ID2LABEL,
                "label2id": LABEL2ID,
                "config": {
                    "epochs": args.epochs,
                    "lr": args.lr,
                    "effective_batch_size": args.effective_batch_size,
                    "micro_batch_size": args.micro_batch_size,
                    "max_length": 8192,
                    "precision": "bf16",
                    "attention": "sdpa"
                }
            }
            with open(output_dir / "training_metadata.json", "w", encoding="utf-8") as f:
                json.dump(metadata, f, indent=2, ensure_ascii=False)

    print(f"\nTraining complete! Best Macro F1: {best_macro_f1*100:.2f}%. Checkpoint saved at {output_dir}")


if __name__ == "__main__":
    main()
