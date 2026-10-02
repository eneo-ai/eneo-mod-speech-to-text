"""The backend as a web server: the security headers on every response, and the built UI.

Adapted from the module kit's packages/bff/src/eneo_module_bff/web.py (kit commit 6621163). The headers keep the kit's
``setdefault`` precedence and the shape of its header set, but not its mechanism (a pure-ASGI middleware, because the
kit's ``@app.middleware`` is Starlette's BaseHTTPMiddleware, which wraps the body of a streamed answer: this app streams
audio and PDFs and must close its upstream when the browser leaves) and not its ``Permissions-Policy`` (the kit's empty
microphone allowlist would stop the recording). ``serve_web`` is the kit's with four changes: the headers come from the
middleware, assets are immutable and the rest revalidated, a path with a control character or a backslash, or too long a
name, is a 404 and never the page or a 500, and HEAD is answered like GET. Plan C (the module kit) deletes this copy.
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import html
import json
import mimetypes
import re
from pathlib import Path

import httpx
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


# The page holds this empty marker; the backend writes what GET /api/branding answers into it, once, at start, so the
# first frame already shows the organisation's mark (a fetch after the first render would pop it in and shift the
# header). A meta element, not a script: the policy allows no inline script.
BRANDING_MARKER = '<meta name="eneo-branding" content="">'
# A file with one of these extensions that has a .br or .gz beside it is served compressed to a client that accepts it.
COMPRESSIBLE = frozenset({".js", ".css", ".svg", ".json", ".html", ".txt"})
ENCODINGS = (("br", ".br"), ("gzip", ".gz"))  # in order of preference
ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"
REVALIDATE = "no-cache"
# The built UI's hashed files live here, and an old one that is gone is a 404, never the page.
ASSETS = "assets"
# A path with one of these (NUL and the rest of C0, DEL, a backslash) names nothing: a 404, never the page.
_NOT_A_NAME = re.compile(r"[\x00-\x1f\x7f\\]")


def _etag(data: bytes) -> str:
    return '"' + hashlib.sha256(data).hexdigest()[:16] + '"'


def _accepted_encodings(accept_encoding: str | None) -> set[str]:
    """The content codings a client names with a quality above zero (``gzip``, ``br;q=0`` is not one)."""
    accepted = set()
    for part in (accept_encoding or "").split(","):
        name, *parameters = (piece.strip() for piece in part.split(";"))
        quality = 1.0
        for parameter in parameters:
            key, _, value = parameter.partition("=")
            if key.strip().lower() == "q":
                try:
                    quality = float(value)
                except ValueError:
                    quality = 0.0
        if name and quality > 0:
            accepted.add(name.lower())
    return accepted


# A JSON answer of the proxy of at least this many bytes is gzipped for a client that accepts it. Smaller ones cost more
# to compress than they save. Next gzipped a proxied answer (880,050 bytes to 87,342, measured in B0.1) and the backend
# alone does not, so the module does it now that Next is gone; only here, never for a streamed file (audio, a PDF).
JSON_COMPRESSION_MIN_BYTES = 1024


def _is_json(content_type: str | None) -> bool:
    media_type = (content_type or "").split(";")[0].strip().lower()
    return media_type == "application/json" or (media_type.startswith("application/") and media_type.endswith("+json"))


async def compress_json(request: Request, upstream: httpx.Response, headers: dict[str, str]) -> bytes:
    """The body to send for a proxied answer: Eneo's content gzipped when that is allowed, with ``headers`` changed to say so.

    Only a whole JSON answer (2xx but not 204 or 206, no Content-Range, not already encoded, to a request without a
    Range) of at least JSON_COMPRESSION_MIN_BYTES, and only for a client that accepts gzip. An answer that could be
    compressed gets ``Vary: Accept-Encoding`` either way, so a cache keeps the two apart. The compression runs off the
    event loop (zlib lets go of the GIL): the live relay shares it.
    """
    content = upstream.content
    if (
        not 200 <= upstream.status_code < 300
        or upstream.status_code in {204, 206}
        or len(content) < JSON_COMPRESSION_MIN_BYTES
        or not _is_json(upstream.headers.get("content-type"))
        or "content-range" in upstream.headers
        or "content-encoding" in upstream.headers
        or "range" in request.headers
    ):
        return content
    headers["Vary"] = "Accept-Encoding"
    if "gzip" not in _accepted_encodings(request.headers.get("accept-encoding")):
        return content
    headers["Content-Encoding"] = "gzip"
    for name in [name for name in headers if name.lower() == "etag" and not headers[name].startswith("W/")]:
        headers[name] = "W/" + headers[name]  # another body of the same resource: no longer a strong validator
    return await asyncio.to_thread(gzip.compress, content, 6)


def _branded_page(index: Path, branding: str) -> bytes:
    """``index`` with its one marker holding ``branding`` (JSON), escaped as an attribute value; refuses any other page."""
    text = index.read_text(encoding="utf-8")
    found = text.count(BRANDING_MARKER)
    if found != 1:
        raise RuntimeError(
            f"{index} must hold exactly one {BRANDING_MARKER} (the organisation is written into it at start); found {found}"
        )
    return text.replace(BRANDING_MARKER, f'<meta name="eneo-branding" content="{html.escape(branding, quote=True)}">').encode()


def _file_under(root: Path, relative: str) -> Path | None:
    """The file ``relative`` names inside ``root``, or None: for a link or a ``..`` that leaves ``root``, a name the
    system refuses (too long, or with a NUL), and anything that is not a file. Never an exception."""
    try:
        candidate = (root / relative).resolve()
        if root not in candidate.parents or not candidate.is_file():
            return None
    except (OSError, ValueError, RuntimeError):
        return None
    return candidate


def serve_web(app: FastAPI, static_dir: Path, *, branding: str) -> None:
    """The built UI: its files, and its one page for every address of the app. Register it after every route.

    ``/api`` and anything under it that no route answered is a 404 JSON; a path whose last segment has a dot names a
    file, and a missing one is a 404 JSON; anything else is ``index.html``. Never the page for a missing file or an
    unknown API path, and never a 500 for a hostile path. ``branding`` is the JSON text GET /api/branding answers; it
    goes into the page's marker, and a page without exactly one marker stops the start.
    """
    root = static_dir.resolve()
    index = root / "index.html"
    # Read once, here: the page is the same for every request. A folder with no index.html answers no page (the
    # launcher refuses to start in that case; the app does not fail to import for it).
    page = _branded_page(index, branding) if index.is_file() else None
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
        # The scope's path, not ``path``: the route's pattern ends in ``$``, which matches before a trailing newline, so
        # ``path`` has lost it.
        if path == "api" or path.startswith("api/") or _NOT_A_NAME.search(request.scope["path"]):
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
        served, encoding = file, None
        if file.suffix in COMPRESSIBLE:
            siblings = {name: sibling for name, suffix in ENCODINGS if (sibling := _file_under(root, path + suffix)) is not None}
            if siblings:
                headers["Vary"] = "Accept-Encoding"
                accepted = _accepted_encodings(request.headers.get("accept-encoding"))
                encoding = next((name for name, _ in ENCODINGS if name in siblings and name in accepted), None)
                if encoding is not None:
                    served = siblings[encoding]
                    headers["Content-Encoding"] = encoding
        stat = served.stat()
        # Each encoding of a file is a different body: its own validator.
        headers["ETag"] = _etag(f"{stat.st_mtime_ns}-{stat.st_size}-{encoding}".encode())
        if etag_matches(request.headers.get("if-none-match"), headers["ETag"]):
            return Response(status_code=304, headers={name: value for name, value in headers.items() if name != "Content-Encoding"})
        if encoding is not None:
            # Not a FileResponse: it would honour a Range, and a range of a compressed file is not a range of the file.
            return Response(content=served.read_bytes(), media_type=mimetypes.guess_type(file.name)[0], headers=headers)
        return FileResponse(file, headers=headers)
