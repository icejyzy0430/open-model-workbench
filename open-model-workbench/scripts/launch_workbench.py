#!/usr/bin/env python3
"""Generate, launch, and open a local model-composition workbench."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

from generate_workbench import GenerationError, MODEL_EXTENSIONS, generate, gltf_dependencies


STATE_FILE = ".model-workbench-server.json"
HOST = "127.0.0.1"


def model_files(sources: list[Path]) -> list[Path]:
    discovered: list[Path] = []
    for source in sources:
        resolved = source.resolve()
        if resolved.is_dir():
            discovered.extend(
                path
                for path in sorted(resolved.rglob("*"))
                if path.is_file() and path.suffix.lower() in MODEL_EXTENSIONS
            )
        elif resolved.is_file() and resolved.suffix.lower() in MODEL_EXTENSIONS:
            discovered.append(resolved)
        else:
            raise GenerationError(f"Model source not found or unsupported: {resolved}")
    unique = list(dict.fromkeys(discovered))
    if not unique:
        raise GenerationError("No GLB/GLTF models found")
    return unique


def copy_selected_models(models: list[Path], staging: Path) -> None:
    for index, model in enumerate(models, start=1):
        model_root = staging / f"model-{index:02d}"
        model_root.mkdir(parents=True, exist_ok=True)
        shutil.copy2(model, model_root / model.name)
        for dependency in gltf_dependencies(model.parent.resolve(), model.resolve()):
            relative = dependency.relative_to(model.parent.resolve())
            destination = model_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dependency, destination)


def url_ready(url: str, timeout: float = 0.8) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def read_state(output_dir: Path) -> dict | None:
    path = output_dir / STATE_FILE
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def write_state(output_dir: Path, state: dict) -> None:
    (output_dir / STATE_FILE).write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def free_port(requested: int) -> int:
    if requested:
        if not 1024 <= requested <= 65535:
            raise GenerationError("--port must be between 1024 and 65535")
        return requested
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((HOST, 0))
        return int(sock.getsockname()[1])


def start_server(
    output_dir: Path, port: int, skill_dir: Path, shutdown_token: str
) -> subprocess.Popen:
    server_script = skill_dir / "scripts" / "serve_workbench.py"
    log_path = output_dir / ".model-workbench-server.log"
    log_handle = log_path.open("ab")
    kwargs: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": log_handle,
        "stderr": subprocess.STDOUT,
        "close_fds": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = (
            subprocess.DETACHED_PROCESS
            | subprocess.CREATE_NEW_PROCESS_GROUP
            | subprocess.CREATE_NO_WINDOW
        )
    else:
        kwargs["start_new_session"] = True
    try:
        return subprocess.Popen(
            [
                sys.executable,
                str(server_script),
                str(output_dir),
                "--host",
                HOST,
                "--port",
                str(port),
                "--shutdown-token",
                shutdown_token,
            ],
            **kwargs,
        )
    finally:
        log_handle.close()


def wait_until_ready(url: str, process: subprocess.Popen, timeout: float = 8.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if url_ready(url):
            return
        if process.poll() is not None:
            raise GenerationError("Workbench server exited before it became ready")
        time.sleep(0.15)
    raise GenerationError(f"Workbench server did not become ready: {url}")


def source_fingerprint(sources: list[Path], models: list[Path]) -> str:
    files = set(models)
    for model in models:
        files.update(gltf_dependencies(model.parent.resolve(), model.resolve()))
    for source in sources:
        config = source.resolve() / "composer.json" if source.resolve().is_dir() else None
        if config and config.is_file():
            files.add(config)
    digest = hashlib.sha256()
    for path in sorted(files, key=lambda item: str(item).lower()):
        stat = path.stat()
        digest.update(str(path.resolve()).encode("utf-8"))
        digest.update(str(stat.st_size).encode("ascii"))
        digest.update(str(stat.st_mtime_ns).encode("ascii"))
    return digest.hexdigest()


def shutdown_server(state: dict) -> bool:
    url = state.get("url")
    token = state.get("shutdownToken")
    if not isinstance(url, str) or not isinstance(token, str):
        return False
    request = urllib.request.Request(
        url.rstrip("/") + "/__workbench_shutdown__",
        data=b"",
        method="POST",
        headers={"X-Workbench-Token": token},
    )
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            if response.status != 204:
                return False
    except (OSError, urllib.error.URLError):
        return False
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        if not url_ready(url):
            return True
        time.sleep(0.1)
    return False


def generate_from_sources(
    sources: list[Path], models: list[Path], output_dir: Path, skill_dir: Path
) -> dict:
    if len(sources) == 1 and sources[0].resolve().is_dir():
        return generate(sources[0], output_dir, skill_dir)

    with tempfile.TemporaryDirectory(prefix="model-workbench-input-") as temp_dir:
        staging = Path(temp_dir)
        copy_selected_models(models, staging)
        return generate(staging, output_dir, skill_dir)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Open a local model-composition workbench.")
    parser.add_argument("sources", nargs="+", type=Path, help="GLB/GLTF files or directories")
    parser.add_argument("--output", type=Path, default=Path.cwd() / "model-workbench-output")
    parser.add_argument("--port", type=int, default=0, help="Local port; 0 chooses a free port")
    parser.add_argument("--no-open", action="store_true", help="Do not open the system browser")
    parser.add_argument("--refresh", action="store_true", help="Regenerate and restart the server")
    parser.add_argument("--skill-dir", type=Path, default=Path(__file__).resolve().parent.parent)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_dir = args.output.resolve()
    skill_dir = args.skill_dir.resolve()
    previous_state = read_state(output_dir)
    try:
        models = model_files(args.sources)
        fingerprint = source_fingerprint(args.sources, models)
        previous_ready = bool(
            previous_state
            and isinstance(previous_state.get("url"), str)
            and url_ready(previous_state["url"])
        )
        signature_matches = bool(
            previous_state
            and previous_state.get("sourceFingerprint") in (None, fingerprint)
        )
        if previous_ready and signature_matches and not args.refresh:
            state = previous_state
            state["sourceFingerprint"] = fingerprint
            state["sourceFiles"] = len(models)
            write_state(output_dir, state)
        else:
            if previous_ready and not shutdown_server(previous_state):
                raise GenerationError(
                    "Could not stop the active workbench server; use a different --output directory"
                )
            config = generate_from_sources(args.sources, models, output_dir, skill_dir)
            port = free_port(args.port)
            url = f"http://{HOST}:{port}/"
            shutdown_token = secrets.token_urlsafe(32)
            process = start_server(output_dir, port, skill_dir, shutdown_token)
            wait_until_ready(url, process)
            state = {
                "url": url,
                "port": port,
                "pid": process.pid,
                "models": len(config["models"]),
                "sourceFiles": len(models),
                "sourceFingerprint": fingerprint,
                "shutdownToken": shutdown_token,
            }
            write_state(output_dir, state)
    except GenerationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if not args.no_open:
        webbrowser.open(state["url"], new=2)
    print(f"WORKBENCH_URL={state['url']}")
    print(f"WORKBENCH_OUTPUT={output_dir}")
    print(f"WORKBENCH_MODELS={state['models']}")
    print(f"WORKBENCH_SOURCE_FILES={state['sourceFiles']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
