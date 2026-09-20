#!/usr/bin/env python3
"""
Fine-tunes alexandrainst/scandi-nli-small on Swedish legal data preserving the 3-way NLI head.
Labels:
  0: entailment (supported)
  1: neutral (unsupported)
  2: contradiction (incorrect & misleading)
"""

import argparse
import json
import time
from pathlib import Path
from typing import Any

import torch
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

from backend.windowing import window_premise

LABEL2ID_3WAY = {
    "supported": 0,
    "unsupported": 1,
    "incorrect": 2,
    "misleading": 2
}
ID2LABEL_3WAY = {0: "entailment", 1: "neutral", 2: "contradiction"}


ATTRIBUTION_AUGMENTATIONS = [
    ("Käranden anförde att avtalet var ogiltigt. Tingsrätten ansåg däremot att avtalet var giltigt.", "Tingsrätten ansåg att avtalet var ogiltigt.", 2),
    ("Svaranden hävdade att skulden var betald. Domstolen fann att skulden inte var betald.", "Domstolen fann att skulden var betald.", 2),
    ("Svaranden invände att fordran var preskriberad. Hovrätten fann att preskription inte inträtt.", "Hovrätten fann att fordran var preskriberad.", 2),
    ("Åklagaren påstod att den tilltalade handlat med uppsåt. Tingsrätten fann att uppsåt inte styrkts.", "Tingsrätten fann att den tilltalade handlat med uppsåt.", 2),
    ("Käranden gjorde gällande att skada uppstått. Domstolen ogillade käromålet på den grunden att skada inte visats.", "Domstolen fann att skada uppstått.", 2),
    ("Parten anförde att ett muntligt avtal träffats. Tingsrätten bedömde att något avtal inte ingåtts.", "Tingsrätten bedömde att ett muntligt avtal träffats.", 2),
    ("Svaranden uppgav att betalning skett kontant. Hovrätten konstaterade att påståendet var motbevisat.", "Hovrätten fann att betalning skett kontant.", 2),
    ("Käranden hävdade att uppsägningen var ogiltig. Arbetsdomstolen fann att uppsägningen var sakligt grundad.", "Arbetsdomstolen fann att uppsägningen var ogiltig.", 2),
    ("Köparen påstod att varan var felaktig. Rätten fann att varan stämde överens med avtalet.", "Rätten fann att varan var felaktig.", 2),
    ("Den part som förlorar målet ska ersätta motpartens rättegångskostnader.", "Den förlorande parten ska betala motpartens kostnader för rättegången.", 0),
    ("Antagande svar som kommer för sent ska gälla som ett nytt anbud.", "Ett svar som kommer för sent ska räknas som ett nytt anbud.", 0),
    ("Ett överklagande ska ha kommit in till tingsrätten inom tre veckor från den dag då domen meddelades.", "Överklagandet måste komma till tingsrätten senast tre veckor efter domen.", 0),
    ("Avtalet måste vara skriftligt och undertecknat av båda parterna.", "Båda parterna måste skriva under det skriftliga avtalet.", 0),
    ("Domstolen nämnde reglerna om preskription men prövade endast frågan om rättegångskostnader.", "Preskriptionstiden för fordringen är tio år.", 1),
    ("I domen hänvisas till skadeståndslagen. Målet gällde dock endast frågan om domstolens behörighet.", "Skadeståndet ska motsvara tio procent av köpeskillingen.", 1),
]


class Windowed3WayDataset(Dataset):
    def __init__(self, data_path: Path | str, tokenizer: Any, max_premise_tokens: int = 380, is_train: bool = False):
        self.examples = []
        with open(data_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                sources = row.get("sources") or ([row["source"]] if "source" in row else [])
                claim = row["claim"]
                premise = window_premise(claim, sources, max_premise_tokens=max_premise_tokens, tokenizer=tokenizer)
                self.examples.append({
                    "premise": premise,
                    "hypothesis": claim,
                    "label": LABEL2ID_3WAY[row["label"]],
                    "id": row.get("id", "")
                })

        if is_train:
            # Augment with hard attribution negatives and paraphrase positives (20x each)
            for premise, hypothesis, label in ATTRIBUTION_AUGMENTATIONS:
                for rep in range(20):
                    self.examples.append({
                        "premise": premise,
                        "hypothesis": hypothesis,
                        "label": label,
                        "id": f"aug_{label}_{rep}"
                    })

    def __len__(self):
        return len(self.examples)

    def __getitem__(self, idx):
        return self.examples[idx]


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


def compute_metrics_3way(preds: list[int], targets: list[int]):
    total = len(targets)
    correct = sum(p == t for p, t in zip(preds, targets))
    accuracy = correct / max(total, 1)

    classes = [0, 1, 2]
    cm = [[0 for _ in classes] for _ in classes]
    for p, t in zip(preds, targets):
        cm[t][p] += 1

    per_class = {}
    f1s = []
    for c in classes:
        tp = cm[c][c]
        fp = sum(cm[i][c] for i in classes if i != c)
        fn = sum(cm[c][i] for i in classes if i != c)
        support = sum(cm[c][i] for i in classes)

        prec = tp / max(tp + fp, 1e-8)
        rec = tp / max(tp + fn, 1e-8)
        f1 = 2 * prec * rec / max(prec + rec, 1e-8)
        f1s.append(f1)
        name = ID2LABEL_3WAY[c]
        per_class[name] = {"precision": prec, "recall": rec, "f1": f1, "support": support}

    macro_f1 = sum(f1s) / len(f1s)
    return {"accuracy": accuracy, "macro_f1": macro_f1, "per_class": per_class, "confusion_matrix": cm}


def evaluate(model, dataloader, device, loss_fct):
    model.eval()
    total_loss = 0.0
    all_preds = []
    all_targets = []

    with torch.no_grad():
        for batch in dataloader:
            input_ids = batch["input_ids"].to(device)
            attention_mask = batch["attention_mask"].to(device)
            labels = batch["labels"].to(device)
            token_type_ids = batch.get("token_type_ids")
            if token_type_ids is not None:
                token_type_ids = token_type_ids.to(device)

            outputs = model(
                input_ids=input_ids,
                attention_mask=attention_mask,
                token_type_ids=token_type_ids,
                labels=labels
            )
            loss = outputs.loss
            total_loss += loss.item() * len(labels)
            logits = outputs.logits
            preds = torch.argmax(logits, dim=-1).cpu().tolist()
            all_preds.extend(preds)
            all_targets.extend(labels.cpu().tolist())

    metrics = compute_metrics_3way(all_preds, all_targets)
    metrics["loss"] = total_loss / max(len(all_targets), 1)
    return metrics


def main():
    parser = argparse.ArgumentParser(description="Fine-tune ScandiNLI-small 3-way.")
    parser.add_argument("--model-name", type=str, default="alexandrainst/scandi-nli-small")
    parser.add_argument("--train-data", type=str, default="data/train.jsonl")
    parser.add_argument("--val-data", type=str, default="data/validation.jsonl")
    parser.add_argument("--output-dir", type=str, default="models/classifier-scandi-nli-small-3way")
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--lr", type=float, default=3e-5)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--grad-accum", type=int, default=2)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using device: {device}")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    tokenizer = AutoTokenizer.from_pretrained(args.model_name)
    model = AutoModelForSequenceClassification.from_pretrained(args.model_name)
    model.to(device)

    print("Preparing 3-way datasets with BM25 paragraph windowing...")
    train_dataset = Windowed3WayDataset(args.train_data, tokenizer=tokenizer, max_premise_tokens=380, is_train=True)
    val_dataset = Windowed3WayDataset(args.val_data, tokenizer=tokenizer, max_premise_tokens=380, is_train=False)

    train_loader = DataLoader(
        train_dataset,
        batch_size=args.batch_size,
        shuffle=True,
        collate_fn=CollateFn(tokenizer),
        num_workers=0
    )
    val_loader = DataLoader(
        val_dataset,
        batch_size=args.batch_size,
        shuffle=False,
        collate_fn=CollateFn(tokenizer),
        num_workers=0
    )

    classifier_params = [p for n, p in model.named_parameters() if "classifier" in n and p.requires_grad]
    backbone_params = [p for n, p in model.named_parameters() if "classifier" not in n and p.requires_grad]
    optimizer = torch.optim.AdamW([
        {"params": backbone_params, "lr": args.lr},
        {"params": classifier_params, "lr": args.lr * 3.0}
    ], weight_decay=0.01)

    total_steps = (len(train_loader) // args.grad_accum) * args.epochs
    warmup_steps = int(total_steps * 0.06)
    scheduler = get_linear_schedule_with_warmup(optimizer, warmup_steps, total_steps)

    # Balanced class weights (avoid suppressing entailment)
    class_weights = torch.tensor([1.0, 1.1, 1.0], device=device, dtype=torch.float32)
    loss_fct = torch.nn.CrossEntropyLoss(weight=class_weights)

    best_macro_f1 = 0.0
    for epoch in range(1, args.epochs + 1):
        model.train()
        total_loss = 0.0
        step = 0
        optimizer.zero_grad()

        for batch in train_loader:
            input_ids = batch["input_ids"].to(device)
            attention_mask = batch["attention_mask"].to(device)
            labels = batch["labels"].to(device)
            token_type_ids = batch.get("token_type_ids")
            if token_type_ids is not None:
                token_type_ids = token_type_ids.to(device)

            outputs = model(
                input_ids=input_ids,
                attention_mask=attention_mask,
                token_type_ids=token_type_ids,
                labels=labels
            )
            loss = loss_fct(outputs.logits, labels)
            loss = loss / args.grad_accum
            loss.backward()

            if (step + 1) % args.grad_accum == 0:
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad()

            total_loss += loss.item() * args.grad_accum
            step += 1

        val_metrics = evaluate(model, val_loader, device, loss_fct)
        print(f"Epoch {epoch}: Val Acc={val_metrics['accuracy']*100:.2f}%, Macro F1={val_metrics['macro_f1']*100:.2f}%")
        for cls_name, m in val_metrics["per_class"].items():
            print(f"  {cls_name:14}: P={m['precision']*100:.1f}%, R={m['recall']*100:.1f}%, F1={m['f1']*100:.1f}%")

        if val_metrics["macro_f1"] > best_macro_f1:
            best_macro_f1 = val_metrics["macro_f1"]
            model.save_pretrained(output_dir)
            tokenizer.save_pretrained(output_dir)
            print(f"--> Saved new best checkpoint (Macro F1: {best_macro_f1*100:.2f}%)")


if __name__ == "__main__":
    main()
