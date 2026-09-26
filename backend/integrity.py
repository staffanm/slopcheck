"""Hashes of the served model files, kept in git while the models are not.

backend/model-integrity.json holds, per model directory name, the size and
SHA-256 of every file ClaimClassifier.load reads. The server refuses a model
whose files differ or that has no entry, the way a browser refuses a script
whose integrity attribute does not match.

Record a model after training or calibrating it:
    python -m backend.integrity models/classifier-kb-bert-4way-v5
"""

import hashlib
import json
import sys
from pathlib import Path

MANIFEST = Path(__file__).with_name("model-integrity.json")
FILES = ("model_quantized.onnx", "model.onnx", "tokenizer.json", "tokenizer_config.json", "config.json", "calibration.json")


def _entry(path: Path) -> dict:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def _served_files(model_dir: Path) -> list[str]:
    # load() reads model.onnx only when there is no quantized file.
    names = [name for name in FILES if (model_dir / name).exists()]
    if "model_quantized.onnx" in names and "model.onnx" in names:
        names.remove("model.onnx")
    return names


def _read() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}


def record(model_dir: Path) -> dict:
    entry = {name: _entry(model_dir / name) for name in _served_files(model_dir)}
    manifest = _read()
    manifest[model_dir.name] = entry
    MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return entry


def verify(model_dir: Path) -> None:
    expected = _read().get(model_dir.name)
    if expected is None:
        raise ValueError(f"{model_dir.name} has no entry in {MANIFEST.name}; run python -m backend.integrity {model_dir}")
    served = _served_files(model_dir)
    problems = [f"{name} is not listed" for name in served if name not in expected]
    for name, want in expected.items():
        path = model_dir / name
        if not path.exists():
            problems.append(f"{name} is missing")
        elif _entry(path) != want:
            problems.append(f"{name} differs")
    if problems:
        raise ValueError(f"{model_dir.name} does not match {MANIFEST.name}: {', '.join(problems)}")


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        print(arg, json.dumps(record(Path(arg)), indent=2))
