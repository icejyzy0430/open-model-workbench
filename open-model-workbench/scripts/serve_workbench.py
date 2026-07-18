#!/usr/bin/env python3
"""Serve one generated workbench on localhost without noisy request logging."""

from __future__ import annotations

import argparse
import functools
import hmac
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class QuietHandler(SimpleHTTPRequestHandler):
    shutdown_token = ""

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_POST(self) -> None:
        if self.path != "/__workbench_shutdown__":
            self.send_error(404)
            return
        supplied = self.headers.get("X-Workbench-Token", "")
        if not self.shutdown_token or not hmac.compare_digest(supplied, self.shutdown_token):
            self.send_error(403)
            return
        self.send_response(204)
        self.end_headers()
        threading.Thread(target=self.server.shutdown, daemon=True).start()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve a generated model workbench.")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--shutdown-token", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    directory = args.directory.resolve()
    if not (directory / "index.html").is_file():
        raise SystemExit(f"Workbench not found: {directory}")
    handler_class = type(
        "BoundQuietHandler", (QuietHandler,), {"shutdown_token": args.shutdown_token}
    )
    handler = functools.partial(handler_class, directory=str(directory))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
