"""The backend as a web server: the security headers on every response, and the built UI.

Adapted from the module kit's packages/bff/src/eneo_module_bff/web.py (kit commit 6621163). The headers keep the kit's
``setdefault`` precedence and the shape of its header set, but not its mechanism (a pure-ASGI middleware, because the
kit's ``@app.middleware`` is Starlette's BaseHTTPMiddleware, which wraps the body of a streamed answer: this app streams
audio and PDFs and must close its upstream when the browser leaves) and not its ``Permissions-Policy`` (the kit's empty
microphone allowlist would stop the recording). ``serve_web`` is the kit's with four changes: the headers come from the
middleware, assets are immutable and the rest revalidated, a path with a NUL byte or too long a name is a 404 and never a
500, and HEAD is answered like GET. Plan C (the module kit) deletes this copy.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# The one definition of the headers every response carries; a header an endpoint sets itself wins (the inline PDF's
# framing, the SVG logo's sandbox, the signed-file rule's nosniff and disposition).
SECURITY_HEADERS: dict[str, str] = json.loads(Path(__file__).with_name("security_headers.json").read_text())


class SecurityHeadersMiddleware:
    """Adds each header in ``headers`` that a response lacks, to every HTTP response, a streamed one and an error too.

    Pure ASGI: the response is passed on as it is built, so a streamed body is not wrapped, a client that leaves ends
    the stream where it always did, and its upstream is closed by the response's own background task.
    """

    def __init__(self, app: ASGIApp, headers: dict[str, str] = SECURITY_HEADERS) -> None:
        self.app = app
        self.headers = [(name.lower().encode("latin-1"), value.encode("latin-1")) for name, value in headers.items()]

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                present = {name.lower() for name, _ in message.get("headers", [])}
                message = {**message, "headers": [*message.get("headers", []), *(h for h in self.headers if h[0] not in present)]}
            await send(message)

        await self.app(scope, receive, send_with_headers)


async def internal_server_error(request: Request, error: Exception) -> PlainTextResponse:
    """What Starlette's own error handler sends for an unhandled exception, with the headers: it answers outside every
    middleware, so the middleware cannot add them to it."""
    return PlainTextResponse("Internal Server Error", status_code=500, headers=SECURITY_HEADERS)


def add_security_headers(app: FastAPI) -> None:
    """Register the headers on ``app``. Call it after the other middleware: the one added last is the outermost, and
    every answer the others give (a 413 before the app runs) must carry the headers."""
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_exception_handler(Exception, internal_server_error)


def etag_matches(if_none_match: str | None, current: str) -> bool:
    if if_none_match is None:
        return False
    listed = {value.strip().removeprefix("W/") for value in if_none_match.split(",")}
    return "*" in listed or current in listed


ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"
REVALIDATE = "no-cache"
# The built UI's hashed files live here, and an old one that is gone is a 404, never the page.
ASSETS = "assets"


def _etag(data: bytes) -> str:
    return '"' + hashlib.sha256(data).hexdigest()[:16] + '"'


def _file_under(root: Path, relative: str) -> Path | None:
    """The file ``relative`` names inside ``root``, or None: for a NUL byte, a backslash, a link or a ``..`` that leaves
    ``root``, a name the system refuses (too long), and anything that is not a file. Never an exception."""
    if "\x00" in relative or "\\" in relative:
        return None
    try:
        candidate = (root / relative).resolve()
        if root not in candidate.parents or not candidate.is_file():
            return None
    except (OSError, ValueError, RuntimeError):
        return None
    return candidate


def serve_web(app: FastAPI, static_dir: Path) -> None:
    """The built UI: its files, and its one page for every address of the app. Register it after every route.

    ``/api`` and anything under it that no route answered is a 404 JSON; a path whose last segment has a dot names a
    file, and a missing one is a 404 JSON; anything else is ``index.html``. Never the page for a missing file or an
    unknown API path, and never a 500 for a hostile path.
    """
    root = static_dir.resolve()
    index = root / "index.html"
    # Read once, here: the page is the same for every request. A folder with no index.html answers no page (the
    # launcher refuses to start in that case; the app does not fail to import for it).
    page = index.read_bytes() if index.is_file() else None
    page_headers = {"Cache-Control": REVALIDATE, "ETag": _etag(page)} if page is not None else {}

    def answer_page(request: Request) -> Response:
        if page is None:
            raise HTTPException(status_code=404)
        if etag_matches(request.headers.get("if-none-match"), page_headers["ETag"]):
            return Response(status_code=304, headers=page_headers)
        return Response(content=page, media_type="text/html; charset=utf-8", headers=page_headers)

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def serve(path: str, request: Request) -> Response:
        last = path.rsplit("/", 1)[-1]
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404)
        # A compressed sibling is served by negotiation only, never by its own name.
        if last.endswith((".br", ".gz")):
            raise HTTPException(status_code=404)
        in_assets = path.startswith(ASSETS + "/")
        if path == "index.html" or (not in_assets and "." not in last):
            return answer_page(request)
        file = _file_under(root, path)
        # ``a/../index.html`` is the raw page, with its marker empty: the page is only ever the processed one.
        if file is None or file == index:
            raise HTTPException(status_code=404)
        headers = {"Cache-Control": ASSET_CACHE_CONTROL if in_assets else REVALIDATE}
        stat = file.stat()
        headers["ETag"] = _etag(f"{stat.st_mtime_ns}-{stat.st_size}".encode())
        if etag_matches(request.headers.get("if-none-match"), headers["ETag"]):
            return Response(status_code=304, headers=headers)
        return FileResponse(file, headers=headers)
