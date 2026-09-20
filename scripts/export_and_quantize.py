#!/usr/bin/env python3
"""
Exports fine-tuned 4-way claim classifier to ONNX and produces INT8 quantized model.
Validates numerical parity against PyTorch reference at 128, 512, 2048, 8192 tokens.
Benchmarks CPU inference latency with 1 and 3 threads.
"""

import argparse
import json
import os
import time
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import onnx
import onnxruntime as ort
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from onnxruntime.quantization import quantize_dynamic, QuantType


def export_to_onnx(model_dir: Path, onnx_path: Path):
    print(f"Loading PyTorch model from {model_dir} with attn_implementation='eager'...")
    model = AutoModelForSequenceClassification.from_pretrained(
        model_dir,
        attn_implementation="eager"
    ).eval().to(torch.float32)

    tokenizer = AutoTokenizer.from_pretrained(model_dir)

    print("Creating sample inputs for ONNX tracing...")
    dummy_input = tokenizer(
        "Detta är en svensk källtext.",
        "Detta är ett svenskt påstående.",
        return_tensors="pt"
    )
    input_names = ["input_ids", "attention_mask"]
    dummy_args = [dummy_input["input_ids"], dummy_input["attention_mask"]]
    dynamic_axes = {
        "input_ids": {0: "batch", 1: "sequence"},
        "attention_mask": {0: "batch", 1: "sequence"},
        "logits": {0: "batch"}
    }
    if "token_type_ids" in dummy_input:
        input_names.append("token_type_ids")
        dummy_args.append(dummy_input["token_type_ids"])
        dynamic_axes["token_type_ids"] = {0: "batch", 1: "sequence"}

    print(f"Exporting to ONNX at {onnx_path} (opset 17, dynamic sequence & batch)...")
    torch.onnx.export(
        model,
        tuple(dummy_args),
        str(onnx_path),
        input_names=input_names,
        output_names=["logits"],
        opset_version=17,
        dynamic_axes=dynamic_axes,
        dynamo=False
    )
    print("Checking exported ONNX model...")
    onnx_model = onnx.load(str(onnx_path))
    onnx.checker.check_model(onnx_model)
    size_mb = onnx_path.stat().st_size / (1024 * 1024)
    print(f"ONNX export successful! Size: {size_mb:.1f} MB")


def quantize_to_int8(onnx_path: Path, quant_path: Path):
    print(f"Quantizing {onnx_path} to INT8 dynamic at {quant_path}...")
    quantize_dynamic(
        model_input=str(onnx_path),
        model_output=str(quant_path),
        weight_type=QuantType.QInt8,
        per_channel=True,
        reduce_range=False
    )
    size_mb = quant_path.stat().st_size / (1024 * 1024)
    print(f"INT8 Quantization complete! Size: {size_mb:.1f} MB")


def verify_numerical_parity(model_dir: Path, onnx_path: Path, quant_path: Path):
    print("\n--- Verifying Numerical Parity Across Context Lengths ---")
    model = AutoModelForSequenceClassification.from_pretrained(
        model_dir,
        attn_implementation="eager"
    ).eval().to(torch.float32)
    tokenizer = AutoTokenizer.from_pretrained(model_dir)

    sess_options = ort.SessionOptions()
    sess_options.intra_op_num_threads = 2
    sess_onnx = ort.InferenceSession(str(onnx_path), sess_options, providers=["CPUExecutionProvider"])
    sess_quant = ort.InferenceSession(str(quant_path), sess_options, providers=["CPUExecutionProvider"])

    max_pos = getattr(model.config, "max_position_embeddings", 512)
    test_lengths = [64, 128, 256, 512] if max_pos <= 512 else [128, 512, 2048, 8192]
    parity_report = {}

    for length in test_lengths:
        # Create input of target token length
        tokens_per_arg = length // 2
        premise = "Detta är lagrumstext " * (tokens_per_arg // 4)
        hypothesis = "Detta är ett påstående " * (tokens_per_arg // 4)

        enc = tokenizer(premise, hypothesis, max_length=length, padding="max_length", truncation=True, return_tensors="pt")
        input_ids = enc["input_ids"]
        attention_mask = enc["attention_mask"]
        actual_len = input_ids.shape[1]

        # PyTorch reference
        model_kwargs = {"input_ids": input_ids, "attention_mask": attention_mask}
        if "token_type_ids" in enc:
            model_kwargs["token_type_ids"] = enc["token_type_ids"]
        with torch.no_grad():
            pt_out = model(**model_kwargs).logits.numpy()

        # ONNX FP32
        ort_inputs = {
            "input_ids": input_ids.numpy().astype(np.int64),
            "attention_mask": attention_mask.numpy().astype(np.int64)
        }
        if "token_type_ids" in enc:
            ort_inputs["token_type_ids"] = enc["token_type_ids"].numpy().astype(np.int64)

        onnx_out = sess_onnx.run(None, ort_inputs)[0]

        # ONNX INT8
        quant_out = sess_quant.run(None, ort_inputs)[0]

        diff_onnx = float(np.max(np.abs(pt_out - onnx_out)))
        diff_quant = float(np.max(np.abs(pt_out - quant_out)))

        # Compare predicted argmax
        pt_pred = int(np.argmax(pt_out[0]))
        onnx_pred = int(np.argmax(onnx_out[0]))
        quant_pred = int(np.argmax(quant_out[0]))
        labels_match = (pt_pred == onnx_pred == quant_pred)

        print(f"Length {actual_len:4d} tokens | ONNX max diff: {diff_onnx:.5f} | INT8 max diff: {diff_quant:.5f} | Preds match: {labels_match}")
        parity_report[actual_len] = {
            "max_diff_fp32": diff_onnx,
            "max_diff_int8": diff_quant,
            "predictions_match": labels_match,
            "pt_pred": pt_pred,
            "quant_pred": quant_pred
        }

    return parity_report


def benchmark_cpu(quant_path: Path, num_threads_list=(1, 3)):
    print("\n--- CPU Latency Benchmarking (ONNX INT8) ---")
    from transformers import AutoConfig
    tokenizer = AutoTokenizer.from_pretrained(str(quant_path.parent))
    config = AutoConfig.from_pretrained(str(quant_path.parent))
    max_len = getattr(config, "max_position_embeddings", 512)
    test_lengths = [64, 128, 256, 512] if max_len <= 512 else [128, 512, 2048, 8192]
    benchmark_results = {}

    for threads in num_threads_list:
        sess_options = ort.SessionOptions()
        sess_options.intra_op_num_threads = threads
        sess = ort.InferenceSession(str(quant_path), sess_options, providers=["CPUExecutionProvider"])
        benchmark_results[f"threads_{threads}"] = {}

        print(f"\nEvaluating with {threads} CPU thread(s):")
        for length in test_lengths:
            tokens_per_arg = length // 2
            premise = "Detta är lagrumstext " * (tokens_per_arg // 4)
            hypothesis = "Detta är ett påstående " * (tokens_per_arg // 4)
            enc = tokenizer(premise, hypothesis, max_length=length, padding="max_length", truncation=True, return_tensors="np")
            ort_inputs = {
                "input_ids": enc["input_ids"].astype(np.int64),
                "attention_mask": enc["attention_mask"].astype(np.int64)
            }
            if "token_type_ids" in enc:
                ort_inputs["token_type_ids"] = enc["token_type_ids"].astype(np.int64)

            # Warmup
            sess.run(None, ort_inputs)

            # Measure runs
            runs = 5
            latencies = []
            for _ in range(runs):
                t0 = time.perf_counter()
                sess.run(None, ort_inputs)
                t1 = time.perf_counter()
                latencies.append((t1 - t0) * 1000.0)

            median_ms = float(np.median(latencies))
            p95_ms = float(np.percentile(latencies, 95))
            print(f"  Length {length:4d} | Median: {median_ms:6.1f} ms | p95: {p95_ms:6.1f} ms")
            benchmark_results[f"threads_{threads}"][length] = {
                "median_ms": round(median_ms, 1),
                "p95_ms": round(p95_ms, 1)
            }

    return benchmark_results


def main():
    parser = argparse.ArgumentParser(description="Export ModernBERT classifier to ONNX INT8.")
    parser.add_argument("--model-dir", type=str, default="models/classifier-mmbert-small-4way")
    args = parser.parse_args()

    model_dir = Path(args.model_dir)
    onnx_path = model_dir / "model.onnx"
    quant_path = model_dir / "model_quantized.onnx"

    export_to_onnx(model_dir, onnx_path)
    quantize_to_int8(onnx_path, quant_path)

    parity = verify_numerical_parity(model_dir, onnx_path, quant_path)
    benchmarks = benchmark_cpu(quant_path, num_threads_list=[1, 3])

    manifest = {
        "model_dir": str(model_dir),
        "onnx_file": str(onnx_path.name),
        "quantized_file": str(quant_path.name),
        "onnx_size_bytes": onnx_path.stat().st_size,
        "quantized_size_bytes": quant_path.stat().st_size,
        "numerical_parity": parity,
        "cpu_benchmarks": benchmarks
    }
    with open(model_dir / "export_manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nExport manifest saved to {model_dir / 'export_manifest.json'}")


if __name__ == "__main__":
    main()
