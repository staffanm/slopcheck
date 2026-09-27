#!/usr/bin/env python3
"""Exports a browser-size classifier to ONNX with 4-bit weights.

Every MatMul becomes MatMulNBits and the word embedding Gather becomes GatherBlockQuantized
(both in the onnxruntime-web 1.30 WASM and WebGPU builds). The result is written as
<model-dir>/model_quantized.onnx, the file backend.model.ClaimClassifier loads, so
scripts/calibrate_onnx.py scores it the same way as the server model.

    python scripts/export_student.py --model-dir models/classifier-kb-bert-4way-student-l3 --block-size 64

With --browser-version it also writes the browser assets to public/models/<version>/: the
4-bit model.onnx, the tokenizer, config.json and a manifest with the labels, the calibration
(from --calibration, as scripts/calibrate_onnx.py writes it) and the size and SHA-256 of each file.
"""

import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer
from transformers import AutoModelForSequenceClassification, AutoTokenizer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--block-size", type=int, default=64)
    parser.add_argument("--browser-version", default=None, help="Also write browser assets to public/models/<version>/.")
    parser.add_argument("--calibration", type=Path, default=None, help="calibration.json for the browser manifest.")
    parser.add_argument("--window-tokens", type=int, default=380, help="Premise window the model was trained on.")
    parser.add_argument("--license", default="26 a § upphovsrättslagen (1960:729) är tillämplig")
    args = parser.parse_args()

    tokenizer = AutoTokenizer.from_pretrained(str(args.model_dir))
    model = AutoModelForSequenceClassification.from_pretrained(str(args.model_dir)).eval()
    enc = tokenizer("Avtalsvillkor får jämkas om villkoret är oskäligt.", "Oskäliga villkor får jämkas.", return_tensors="pt")
    names = [name for name in ("input_ids", "attention_mask", "token_type_ids") if name in enc]
    fp32 = args.model_dir / "model.onnx"
    torch.onnx.export(model, tuple(enc[name] for name in names), str(fp32), input_names=names, output_names=["logits"],
                      dynamic_axes={**{name: {0: "batch", 1: "sequence"} for name in names}, "logits": {0: "batch"}},
                      opset_version=17, dynamo=False)
    quantizer = MatMulNBitsQuantizer(onnx.load(str(fp32)), bits=4, block_size=args.block_size, is_symmetric=True,
                                     op_types_to_quantize=("MatMul", "Gather"), quant_axes=(("MatMul", 0), ("Gather", 1)))
    quantizer.process()
    q4 = args.model_dir / "model_quantized.onnx"
    onnx.save(quantizer.model.model, str(q4))

    feeds = {name: enc[name].numpy().astype(np.int64) for name in names}
    with torch.no_grad():
        reference = model(**enc).logits.numpy()
    logits = ort.InferenceSession(str(q4), providers=["CPUExecutionProvider"]).run(None, feeds)[0]
    print(f"{args.model_dir}: fp32 {os.path.getsize(fp32) / 1e6:.1f} MB, 4-bit {os.path.getsize(q4) / 1e6:.1f} MB, "
          f"largest logit difference {np.abs(reference - logits).max():.3f}, same label {bool((reference.argmax(-1) == logits.argmax(-1)).all())}")
    if args.browser_version:
        write_browser_assets(args, model, q4)


def write_browser_assets(args, model, q4: Path) -> None:
    out = Path("public/models") / args.browser_version
    out.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(q4, out / "model.onnx")
    for name in ("tokenizer.json", "tokenizer_config.json", "config.json"):
        shutil.copyfile(args.model_dir / name, out / name)
    calibration = json.loads(args.calibration.read_text(encoding="utf-8"))
    labels = [model.config.id2label[i] for i in range(model.config.num_labels)]
    files = {}
    for name in ("model.onnx", "tokenizer.json", "tokenizer_config.json", "config.json"):
        data = (out / name).read_bytes()
        files[name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    manifest = {
        "model": str(args.model_dir), "version": args.browser_version, "license": args.license,
        "quantization": f"4-bit weights (MatMulNBits, GatherBlockQuantized, block {args.block_size}), float32 activations",
        "premise": "window", "window_tokens": args.window_tokens, "labels": labels,
        "calibration": {"temperature": calibration["temperature"], "minimum_margin": calibration["minimum_margin"],
                        "thresholds": {label: round(calibration["thresholds"][label], 4) for label in labels},
                        "calibration_rows": calibration["calibration_rows"],
                        "policy": "fail-closed, target precision per label as in scripts/calibrate_onnx.py; above 1 disables a label"},
        "files": files,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Browser assets in {out}: {sum(f['bytes'] for f in files.values()) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
