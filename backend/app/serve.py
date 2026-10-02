"""The one way the backend is started: ``python -m app.serve``.

Copied from the module kit's packages/bff/src/eneo_module_bff/serve.py (kit commit 6621163), with server_header off, the
options the module fixes refused, ``reload`` and ``api_only`` added, and the WebSocket limits moved to app/limits.py.
Plan C (the module kit) deletes this copy when the module moves onto the released package.

It fixes what the running system depends on, in one place:

- one worker: the session store is process-local (``ModuleSessionStore``), so a second worker would misroute people;
- no access log: the callback URL carries a one-time ticket;
- no ``Server: uvicorn`` banner;
- the browser WebSocket limits of ``app.limits``;
- a stop that does not wait for open streams past 8 s (Docker kills a container ten seconds after SIGTERM, and a file that
  is still streaming never ends by itself).

Without ``--api-only`` the launcher serves the built UI, and refuses to start unless ``STATIC_DIR`` (read by
``Settings``, the one reader) holds its ``index.html``: a deployment with no page is a failed start, not a running API that answers 404 to every visit.
"""

from __future__ import annotations

import argparse
from collections.abc import Sequence

import uvicorn

from app.config import load_settings
from app.limits import WS_MAX_MESSAGE_BYTES

APP = "app.main:app"
GRACEFUL_SHUTDOWN_SECONDS = 8
HOST = "0.0.0.0"
PORT = 3001


def _refuse_without_a_built_ui() -> None:
    # Settings is the one reader of STATIC_DIR, so the launcher and the app cannot disagree about the folder (and a
    # missing or wrong setting stops the launch here, before the app is imported, as any other bad setting does).
    folder = load_settings().static_dir
    if folder is None:
        raise SystemExit(
            "STATIC_DIR is not set: it must name the folder with the built UI (its index.html). "
            "Build the UI, or pass --api-only to run the API alone."
        )
    if not (folder / "index.html").is_file():
        raise SystemExit(
            f"{folder} has no index.html: STATIC_DIR must name the folder with the built UI. "
            "Build the UI, or pass --api-only to run the API alone."
        )


def serve(
    app: str,
    *,
    host: str = HOST,
    port: int = PORT,
    reload: bool = False,
    api_only: bool = False,
    **overrides: object,
) -> None:
    """Run the module; ``app`` is an import string (``reload`` needs one: uvicorn imports it again in the child).

    Other uvicorn options pass through; the ones fixed above are refused, even with the value they have.
    """
    options: dict[str, object] = {
        "workers": 1,
        "access_log": False,
        "server_header": False,
        "ws_max_size": WS_MAX_MESSAGE_BYTES,
        "timeout_graceful_shutdown": GRACEFUL_SHUTDOWN_SECONDS,
    }
    if refused := sorted(options.keys() & overrides.keys()):
        raise ValueError(f"fixed by the launcher, not options: {', '.join(refused)}")
    if reload and not isinstance(app, str):
        raise ValueError("reload needs the app as an import string")
    if not api_only:
        _refuse_without_a_built_ui()
    uvicorn.run(app, host=host, port=port, reload=reload, **options, **overrides)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python -m app.serve", description="Run the Eneo speech-to-text module.")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--reload", action="store_true", help="restart on code changes (development)")
    parser.add_argument(
        "--api-only", action="store_true", help="serve no UI: for development against the Vite dev server, and tests"
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    arguments = parse_args(argv)
    serve(APP, host=arguments.host, port=arguments.port, reload=arguments.reload, api_only=arguments.api_only)


if __name__ == "__main__":
    main()
