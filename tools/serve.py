#!/usr/bin/env python3
"""Static file server for AeroMind XR.

A plain ``python3 -m http.server`` works for viewing the experience, but it lets
the browser cache ES modules aggressively, which makes editing a source file and
reloading unreliable — you get the previous version back with no indication that
anything is stale.

This server is the same thing with two additions that matter during development:

* ``Cache-Control: no-store`` on every response, so a reload always fetches the
  current file.
* The correct MIME type for ``.js``/``.mjs``/``.wasm``, which some Python builds
  get wrong and which ES module loading is strict about.

For deployment, any ordinary static host will do — see README.md.

Usage::

    python3 tools/serve.py [port]
"""

from __future__ import annotations

import functools
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PORT = 8137


class NoCacheHandler(SimpleHTTPRequestHandler):
    """Serves the project directory with caching disabled."""

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".hdr": "image/vnd.radiance",
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
    }

    def end_headers(self) -> None:
        """Adds no-store caching headers before the header block is closed."""
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        """Logs only failures; a successful asset fetch is not news."""
        status = str(args[1]) if len(args) > 1 else ""
        if status.startswith(("4", "5")):
            super().log_message(fmt, *args)


def main() -> int:
    """Starts the server.

    :returns: Process exit code.
    """
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    handler = functools.partial(NoCacheHandler, directory=ROOT)

    with ThreadingHTTPServer(("0.0.0.0", port), handler) as httpd:
        print(f"AeroMind XR  →  http://localhost:{port}")
        print(f"Serving       {ROOT}")
        print("Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
