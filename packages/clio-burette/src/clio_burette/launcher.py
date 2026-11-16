"""Start the bundled Burette MCP server with the Node.js from ``nodejs-wheel-binaries``.

The server is one prebuilt ES module (``bundle/server.mjs``) with its views and
runtime assets beside it, so nothing is built or installed on first start. stdio
is handed straight to Node: the MCP client talks to the Node process, and this
launcher only prints diagnostics to stderr (stdout carries the protocol).
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

BUNDLE = Path(__file__).resolve().parent / "bundle"
SERVER = BUNDLE / "server.mjs"


class LaunchError(RuntimeError):
    """A typed launch failure; ``reason`` is stable for callers that read stderr."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


def node_executable() -> Path:
    """The Node.js binary shipped by the ``nodejs-wheel-binaries`` wheel."""
    try:
        import nodejs_wheel  # noqa: PLC0415 - optional at import time, required to run
    except ImportError as error:
        raise LaunchError(
            "node_runtime_missing",
            "nodejs-wheel-binaries is not installed in this environment.",
        ) from error
    root = Path(nodejs_wheel.__file__).resolve().parent
    for candidate in (root / "bin" / "node", root / "node.exe", root / "bin" / "node.exe"):
        if candidate.is_file():
            return candidate
    raise LaunchError("node_runtime_missing", f"No node executable under {root}.")


def main(argv: list[str] | None = None) -> int:
    """Run the server; returns Node's exit code (or 2 for a launch failure)."""
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] in (["--version"], ["-V"]):
        from clio_burette import __version__  # noqa: PLC0415

        print(f"burette-clio {__version__}")
        return 0
    try:
        if not SERVER.is_file():
            raise LaunchError("bundle_missing", f"The prebuilt server is missing: {SERVER}")
        node = node_executable()
    except LaunchError as error:
        print(f"[burette-clio] launch failed ({error.reason}): {error}", file=sys.stderr)
        return 2
    command = [str(node), str(SERVER), *args]
    if os.name == "posix":
        os.execv(command[0], command)  # replace this process: signals and stdio go to Node
    return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())
