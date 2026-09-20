# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["torch==2.6.0", "transformers==4.49.0", "onnx==1.17.0", "numpy==2.2.6"]
# [tool.uv.sources]
# torch = { index = "pytorch-cpu" }
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# ///
"""Export the pinned ScandiNLI model with 8-bit weights for the static SPA."""

import argparse
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import onnx
import torch
from onnx import helper, numpy_helper
from transformers import AutoModelForSequenceClassification, AutoTokenizer

MODEL = "alexandrainst/scandi-nli-small"
REVISION = "5c7d1eec144f2342823d829693d19cf5230b32a9"
VERSION = "scandi-nli-small-5c7d1ee-q8-v1"
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "public" / "models" / VERSION


def main():
    parser = argparse.ArgumentParser(description="Export ScandiNLI model with 8-bit weights for ONNX Runtime Web.")
    parser.add_argument("--model-dir", type=str, default=MODEL, help="Model path or HF repo name")
    parser.add_argument("--output-dir", type=str, default=str(DEFAULT_OUTPUT), help="Output directory")
    args = parser.parse_args()

    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    if Path(args.model_dir).is_dir():
        tokenizer = AutoTokenizer.from_pretrained(args.model_dir)
        model = AutoModelForSequenceClassification.from_pretrained(args.model_dir).eval()
    else:
        tokenizer = AutoTokenizer.from_pretrained(args.model_dir, revision=REVISION)
        model = AutoModelForSequenceClassification.from_pretrained(
            args.model_dir, revision=REVISION, attn_implementation="eager"
        ).eval()
    assert model.config.id2label == {0: "entailment", 1: "neutral", 2: "contradiction"}
    tokenizer.save_pretrained(output)
    model.config.save_pretrained(output)
    inputs = tokenizer("Ett sent svar är ett nytt anbud.", "Svaret kommer för sent.", return_tensors="pt")
    names = ["input_ids", "attention_mask", "token_type_ids"]
    with TemporaryDirectory() as temporary:
        path = Path(temporary) / "model.onnx"
        with torch.no_grad():
            torch.onnx.export(
                model, tuple(inputs[name] for name in names), path,
                input_names=names, output_names=["logits"], opset_version=17,
                dynamic_axes={**{name: {0: "batch", 1: "sequence"} for name in names}, "logits": {0: "batch"}},
                dynamo=False,
            )
        graph = onnx.load(path)
    # Weight-only QDQ also quantizes the large vocabulary embedding. Keep
    # activations float32 and standard ONNX operators for WebGPU and WASM.
    dequantizers = []
    for weight in list(graph.graph.initializer):
        values = numpy_helper.to_array(weight)
        if values.dtype != np.float32 or values.ndim != 2 or values.size < 1024:
            continue
        scale = np.float32(np.abs(values).max() / 127)
        assert scale > 0, f"Empty weight range: {weight.name}"
        quantized = np.clip(np.rint(values / scale), -127, 127).astype(np.int8)
        graph.graph.initializer.remove(weight)
        graph.graph.initializer.extend([
            numpy_helper.from_array(quantized, weight.name + ".q8"),
            numpy_helper.from_array(np.array(scale), weight.name + ".scale"),
            numpy_helper.from_array(np.array(0, dtype=np.int8), weight.name + ".zero"),
        ])
        dequantizers.append(helper.make_node("DequantizeLinear", [weight.name + suffix for suffix in [".q8", ".scale", ".zero"]], [weight.name]))
    original_nodes = list(graph.graph.node)
    del graph.graph.node[:]
    graph.graph.node.extend(dequantizers + original_nodes)
    onnx.checker.check_model(graph)
    onnx.save(graph, output / "model.onnx")
    files = {name: {"bytes": (output / name).stat().st_size, "sha256": hashlib.sha256((output / name).read_bytes()).hexdigest()}
             for name in ["model.onnx", "tokenizer.json", "tokenizer_config.json", "config.json"]}
    manifest = {"model": args.model_dir, "revision": REVISION, "version": VERSION, "license": "Apache-2.0", "quantization": "symmetric int8 weights, float32 activations", "premise": "passage", "files": files}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
