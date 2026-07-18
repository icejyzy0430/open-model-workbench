#!/usr/bin/env python3
"""Generate a self-contained multi-model composition workbench."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import uuid
from pathlib import Path
from urllib.parse import unquote, urlparse


MODEL_EXTENSIONS = {".glb", ".gltf"}
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
VALID_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class GenerationError(Exception):
    """Expected input or generation error suitable for CLI output."""


def require_string(value: object, label: str, default: str | None = None) -> str:
    if value is None and default is not None:
        return default
    if not isinstance(value, str) or not value.strip():
        raise GenerationError(f"{label} must be a non-empty string")
    return value


def require_number(value: object, label: str, minimum: float, maximum: float) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise GenerationError(f"{label} must be a number")
    number = float(value)
    if not minimum <= number <= maximum:
        raise GenerationError(f"{label} must be between {minimum} and {maximum}")
    return number


def require_vector3(value: object, label: str, minimum: float, maximum: float) -> list[float]:
    if not isinstance(value, list) or len(value) != 3:
        raise GenerationError(f"{label} must contain three numbers")
    return [
        require_number(component, f"{label}[{index}]", minimum, maximum)
        for index, component in enumerate(value)
    ]


def require_color(value: object, label: str, default: str) -> str:
    color = require_string(value, label, default)
    if not HEX_COLOR.fullmatch(color):
        raise GenerationError(f"{label} must use #RRGGBB")
    return color.upper()


def slugify(value: str, fallback: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or fallback


def normalize_config(config: object) -> dict:
    if not isinstance(config, dict):
        raise GenerationError("composer.json must be a JSON object")
    models_value = config.get("models")
    if not isinstance(models_value, list) or not models_value:
        raise GenerationError("composer.json must contain a non-empty 'models' array")

    normalized_models = []
    identifiers = set()
    total = len(models_value)
    for index, item in enumerate(models_value):
        prefix = f"models[{index}]"
        if not isinstance(item, dict):
            raise GenerationError(f"{prefix} must be an object")
        model = require_string(item.get("model"), prefix + ".model")
        model_id = require_string(
            item.get("id"), prefix + ".id", slugify(Path(model).stem, f"model-{index + 1}")
        )
        if not VALID_ID.fullmatch(model_id):
            raise GenerationError(f"{prefix}.id must use lowercase letters, digits, and hyphens")
        if model_id in identifiers:
            raise GenerationError(f"Duplicate model id: {model_id}")
        identifiers.add(model_id)
        default_x = (index - (total - 1) / 2) * 2.2
        normalized_models.append(
            {
                "id": model_id,
                "label": require_string(
                    item.get("label"),
                    prefix + ".label",
                    Path(model).stem.replace("-", " ").replace("_", " ").title(),
                ),
                "model": Path(model).as_posix(),
                "position": require_vector3(
                    item.get("position", [default_x, 0, 0]), prefix + ".position", -20, 20
                ),
                "rotation": require_vector3(
                    item.get("rotation", [0, 0, 0]), prefix + ".rotation", -360, 360
                ),
                "scale": require_number(item.get("scale", 1), prefix + ".scale", 0.1, 5),
            }
        )

    capture_value = config.get("capture", {})
    if not isinstance(capture_value, dict):
        raise GenerationError("capture must be an object")
    width = capture_value.get("width", 1920)
    height = capture_value.get("height", 1080)
    if not isinstance(width, int) or not 1024 <= width <= 3840:
        raise GenerationError("capture.width must be an integer from 1024 to 3840")
    if not isinstance(height, int) or not 720 <= height <= 2160:
        raise GenerationError("capture.height must be an integer from 720 to 2160")
    if not 1.3 <= width / height <= 2.4:
        raise GenerationError("capture dimensions must use a desktop landscape aspect ratio")

    grid = config.get("grid", True)
    safe_frame = config.get("safeFrame", True)
    if not isinstance(grid, bool) or not isinstance(safe_frame, bool):
        raise GenerationError("grid and safeFrame must be booleans")
    background = require_color(config.get("background"), "background", "#111411")
    return {
        "pageTitle": require_string(config.get("pageTitle"), "pageTitle", "Model Workbench"),
        "language": require_string(config.get("language"), "language", "zh-CN"),
        "background": background,
        "grid": grid,
        "safeFrame": safe_frame,
        "capture": {
            "width": width,
            "height": height,
            "background": require_color(
                capture_value.get("background"), "capture.background", background
            ),
        },
        "models": normalized_models,
    }


def discovered_config(input_root: Path, selected: list[str] | None = None) -> dict:
    models = selected or sorted(
        path.relative_to(input_root).as_posix()
        for path in input_root.rglob("*")
        if path.is_file() and path.suffix.lower() in MODEL_EXTENSIONS
    )
    if not models:
        raise GenerationError("No GLB/GLTF models found")
    identifiers: dict[str, int] = {}
    entries = []
    for index, model in enumerate(models):
        base = slugify(Path(model).stem, f"model-{index + 1}")
        identifiers[base] = identifiers.get(base, 0) + 1
        model_id = base if identifiers[base] == 1 else f"{base}-{identifiers[base]}"
        entries.append(
            {
                "id": model_id,
                "label": Path(model).stem.replace("-", " ").replace("_", " ").title(),
                "model": model,
            }
        )
    return {"models": entries}


def load_config(input_root: Path, selected: list[str] | None = None) -> dict:
    if selected:
        return normalize_config(discovered_config(input_root, selected))
    config_path = input_root / "composer.json"
    if not config_path.is_file():
        return normalize_config(discovered_config(input_root))
    try:
        return normalize_config(json.loads(config_path.read_text(encoding="utf-8")))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GenerationError(f"Invalid composer.json: {exc}") from exc


def paths_overlap(first: Path, second: Path) -> bool:
    return first == second or first in second.parents or second in first.parents


def validate_roots(input_dir: Path, output_dir: Path, skill_dir: Path) -> tuple[Path, Path, Path]:
    input_root = input_dir.resolve()
    output_root = output_dir.resolve()
    skill_root = skill_dir.resolve()
    if not input_root.is_dir():
        raise GenerationError(f"Input directory not found: {input_root}")
    if output_root.parent == output_root:
        raise GenerationError("Output directory cannot be a filesystem root")
    if output_root.exists() and not output_root.is_dir():
        raise GenerationError("Output path already exists and is not a directory")
    for label, protected in (("input", input_root), ("skill", skill_root)):
        if paths_overlap(output_root, protected):
            raise GenerationError(f"Output directory must not overlap the {label} directory")
    return input_root, output_root, skill_root


def safe_local_file(
    root: Path, relative_value: str, label: str, extensions: set[str] | None = None
) -> Path:
    relative = Path(relative_value)
    if relative.is_absolute() or ".." in relative.parts:
        raise GenerationError(f"{label} must stay inside the input directory")
    source = (root / relative).resolve()
    if not source.is_relative_to(root):
        raise GenerationError(f"{label} resolves outside the input directory")
    if extensions is not None and source.suffix.lower() not in extensions:
        raise GenerationError(f"{label} must use one of {sorted(extensions)}")
    if not source.is_file():
        raise GenerationError(f"{label} not found: {source}")
    return source


def gltf_dependencies(input_root: Path, model_source: Path) -> list[Path]:
    if model_source.suffix.lower() != ".gltf":
        return []
    try:
        document = json.loads(model_source.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GenerationError(f"Invalid GLTF file {model_source.name}: {exc}") from exc

    dependencies = []
    for collection in (document.get("buffers", []), document.get("images", [])):
        if not isinstance(collection, list):
            raise GenerationError(f"Invalid GLTF dependency list in {model_source.name}")
        for item in collection:
            if not isinstance(item, dict) or "uri" not in item:
                continue
            uri = item["uri"]
            if not isinstance(uri, str):
                raise GenerationError(f"Invalid GLTF dependency URI in {model_source.name}")
            parsed = urlparse(uri)
            if parsed.scheme == "data":
                continue
            if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
                raise GenerationError(f"GLTF dependency must be a local file: {uri}")
            relative = model_source.parent.relative_to(input_root) / unquote(parsed.path)
            dependencies.append(
                safe_local_file(input_root, relative.as_posix(), f"GLTF dependency {uri}")
            )
    return dependencies


def build_copy_plan(input_root: Path, config: dict) -> list[tuple[Path, Path]]:
    planned: dict[Path, Path] = {}
    for index, model_config in enumerate(config["models"]):
        model = safe_local_file(
            input_root, model_config["model"], f"models[{index}].model", MODEL_EXTENSIONS
        )
        for source in [model, *gltf_dependencies(input_root, model)]:
            planned[source.relative_to(input_root)] = source
    return [(source, relative) for relative, source in planned.items()]


def validate_assets(skill_root: Path) -> Path:
    assets = skill_root / "assets" / "workbench"
    required = [
        assets / "index.html",
        assets / "composer.css",
        assets / "composer.js",
        assets / "vendor" / "three.module.min.js",
        assets / "vendor" / "three.core.min.js",
        assets / "vendor" / "loaders" / "GLTFLoader.js",
        assets / "vendor" / "loaders" / "DRACOLoader.js",
        assets / "vendor" / "controls" / "TransformControls.js",
        assets / "vendor" / "utils" / "BufferGeometryUtils.js",
        assets / "vendor" / "draco" / "draco_decoder.wasm",
        assets / "vendor" / "lucide.min.js",
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise GenerationError("Workbench assets missing: " + ", ".join(missing))
    return assets


def write_config_js(output_dir: Path, config: dict) -> None:
    payload = json.dumps(config, ensure_ascii=False, indent=2).replace("\u2028", "\\u2028").replace(
        "\u2029", "\\u2029"
    )
    (output_dir / "composer-config.js").write_text(
        f"window.MODEL_WORKBENCH_CONFIG = {payload};\n", encoding="utf-8"
    )


def atomic_publish(staging: Path, output_root: Path) -> None:
    backup = output_root.with_name(f".{output_root.name}.backup-{uuid.uuid4().hex}")
    moved_old = False
    try:
        if output_root.exists():
            os.replace(output_root, backup)
            moved_old = True
        os.replace(staging, output_root)
    except OSError:
        if moved_old and backup.exists() and not output_root.exists():
            os.replace(backup, output_root)
        raise
    else:
        if backup.exists():
            shutil.rmtree(backup)


def populate_staging(
    staging: Path,
    workbench_assets: Path,
    copy_plan: list[tuple[Path, Path]],
    config: dict,
) -> None:
    for source in workbench_assets.iterdir():
        destination = staging / source.name
        if source.is_dir():
            shutil.copytree(source, destination)
        else:
            shutil.copy2(source, destination)
    models_dir = staging / "assets" / "models"
    for source, relative in copy_plan:
        destination = models_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    write_config_js(staging, config)


def generate(
    input_dir: Path,
    output_dir: Path,
    skill_dir: Path,
    selected: list[str] | None = None,
) -> dict:
    input_root, output_root, skill_root = validate_roots(input_dir, output_dir, skill_dir)
    config = load_config(input_root, selected)
    copy_plan = build_copy_plan(input_root, config)
    workbench_assets = validate_assets(skill_root)
    output_root.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output_root.name}.tmp-", dir=output_root.parent))
    try:
        populate_staging(staging, workbench_assets, copy_plan, config)
        atomic_publish(staging, output_root)
    except (OSError, shutil.Error) as exc:
        raise GenerationError(f"Could not generate model workbench: {exc}") from exc
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return config


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a multi-model composition workbench.")
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--model", action="append", default=[], help="Relative GLB/GLTF path")
    parser.add_argument("--skill-dir", type=Path, default=Path(__file__).resolve().parent.parent)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        config = generate(args.input_dir, args.output_dir, args.skill_dir, args.model or None)
    except GenerationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(f"WORKBENCH_OUTPUT={args.output_dir.resolve()}")
    print(f"WORKBENCH_MODELS={len(config['models'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
