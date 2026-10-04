"""The backend as a web server: the security headers on every response, and the built UI.

Adapted from the module kit's packages/bff/src/eneo_module_bff/web.py (kit commit 6621163). The headers keep the kit's
``setdefault`` precedence and the shape of its header set, but not its mechanism (a pure-ASGI middleware, because the
kit's ``@app.middleware`` is Starlette's BaseHTTPMiddleware, which wraps the body of a streamed answer: this app streams
audio and PDFs and must close its upstream when the browser leaves) and not its ``Permissions-Policy`` (the kit's empty
microphone allowlist would stop the recording). ``serve_web`` is the kit's with four changes: the headers come from the
middleware, assets are immutable and the rest revalidated, a path with a control character or a backslash, or too long a
name, is a 404 and never the page or a 500, and HEAD is answered like GET. The files of dist/ are indexed once, at start,
and a request looks its path up (``index_files``). Plan C (the module kit) deletes this copy.
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import html
import json
import mimetypes
import os
import re
from pathlib import Path
from typing import NamedTuple

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# The one definition of the headers every response carries; a header an endpoint sets itself wins (the inline PDF's
# framing, the SVG logo's sandbox, the signed-file rule's nosniff and disposition).
SECURITY_HEADERS: dict[str, str] = json.loads(Path(__file__).with_name("security_headers.json").read_text())


NO_STORE = (b"cache-control", b"no-store")


class SecurityHeadersMiddleware:
    """Adds each header in ``headers`` that a response lacks, to every HTTP response, a streamed one and an error too.
    An answer under ``/api`` also gets ``Cache-Control: no-store`` if it says nothing about caching: a transcript must
    not land in a shared computer's disk cache. A route that sets its own (the theme, the logo) keeps it.

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

        api = scope["path"] == "/api" or scope["path"].startswith("/api/")
        added = [*self.headers, *([NO_STORE] if api else [])]

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                present = {name.lower() for name, _ in message.get("headers", [])}
                message = {**message, "headers": [*message.get("headers", []), *(h for h in added if h[0] not in present)]}
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
# A path with one of these (NUL and the rest of C0, DEL, a backslash), or a segment that starts with a dot (a dotfile, "."
# and ".."), names nothing: a 404, never the page, a file or a way past the /api rule.
_NOT_A_NAME = re.compile(r"[\x00-\x1f\x7f\\]|(?:^|/)\.")


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


class _Variant(NamedTuple):
    """One body a file is served as: the file read, its stat (taken at start), and the validator of that body."""

    path: Path
    stat: os.stat_result
    etag: str


class _Asset(NamedTuple):
    media_type: str | None
    plain: _Variant
    encodings: dict[str, _Variant]  # "br" and "gzip": the precompressed siblings that exist, for a file that may have them


def _variant(path: Path, encoding: str | None) -> _Variant:
    stat = path.stat()
    # Each encoding of a file is a different body: its own validator.
    return _Variant(path, stat, _etag(f"{stat.st_mtime_ns}-{stat.st_size}-{encoding}".encode()))


def index_files(root: Path, page: Path) -> dict[str, _Asset]:
    """Every file the built UI serves, by the path it is asked for under ``root``, found once.

    dist/ is the same for the life of the process (it is part of the image), so what a request needs to know about a
    file (where it really is, its size and time, its ETag, which precompressed siblings it has) is read here and not
    per request, where it was a resolve, an is_file and the sibling checks on the event loop. A file is in the index
    unless it is a dotfile or in a dot folder, a name no request can carry (a control character, a backslash), the page
    itself (served processed, never raw), or a link that leaves ``root`` (``_file_under``). A ``.br`` or ``.gz`` is
    never served by its own name, only as the sibling of the file it compresses. A file that appears later is not here.
    """
    found: dict[str, Path] = {}
    for directory, directories, names in os.walk(root):
        directories[:] = [name for name in directories if not name.startswith(".")]
        for name in names:
            relative = (Path(directory) / name).relative_to(root).as_posix()
            if not _NOT_A_NAME.search(relative) and (target := _file_under(root, relative)) is not None:
                found[relative] = target
    assets: dict[str, _Asset] = {}
    for relative, target in found.items():
        if relative.endswith((".br", ".gz")) or target == page:
            continue
        siblings = {}
        if target.suffix in COMPRESSIBLE:
            siblings = {name: _variant(found[relative + suffix], name) for name, suffix in ENCODINGS if relative + suffix in found}
        assets[relative] = _Asset(mimetypes.guess_type(target.name)[0], _variant(target, None), siblings)
    return assets


def serve_web(app: FastAPI, static_dir: Path, *, branding: str) -> None:
    """The built UI: its files, and its one page for every address of the app. Register it after every route.

    ``/api`` and anything under it that no route answered is a 404 JSON; a path whose last segment has a dot names a
    file, and a missing one is a 404 JSON; anything else is ``index.html``. Never the page for a missing file or an
    unknown API path, and never a 500 for a hostile path. ``branding`` is the JSON text GET /api/branding answers; it
    goes into the page's marker, and a page without exactly one marker stops the start. The files are indexed here,
    once (``index_files``): a request looks its path up and does not touch the file system to find a file.
    """
    root = static_dir.resolve()
    index = root / "index.html"
    assets = index_files(root, index)
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
        # The scope's path, not ``path``: the route's pattern drops one leading slash (``//api/x`` is ``/api/x``) and, ending
        # in ``$``, a trailing newline.
        asked = request.scope["path"]
        if _NOT_A_NAME.search(asked) or asked.lstrip("/") == "api" or asked.lstrip("/").startswith("api/"):
            raise HTTPException(status_code=404)
        # A compressed sibling is served by negotiation only, never by its own name.
        if last.endswith((".br", ".gz")):
            raise HTTPException(status_code=404)
        in_assets = path.startswith(ASSETS + "/")
        if path == "index.html" or (not in_assets and "." not in last):
            return answer_page(request)
        # Absent is a 404: a file the index does not hold (a raw ``a/../index.html``, a file with a trailing slash, one added
        # since the start) is never served; a file has one URL and the page is only ever the processed one.
        asset = assets.get(path)
        if asset is None:
            raise HTTPException(status_code=404)
        headers = {"Cache-Control": ASSET_CACHE_CONTROL if in_assets else REVALIDATE}
        served, encoding = asset.plain, None
        if asset.encodings:
            headers["Vary"] = "Accept-Encoding"
            accepted = _accepted_encodings(request.headers.get("accept-encoding"))
            encoding = next((name for name, _ in ENCODINGS if name in asset.encodings and name in accepted), None)
            if encoding is not None:
                served = asset.encodings[encoding]
                headers["Content-Encoding"] = encoding
        headers["ETag"] = served.etag
        if etag_matches(request.headers.get("if-none-match"), headers["ETag"]):
            return Response(status_code=304, headers={name: value for name, value in headers.items() if name != "Content-Encoding"})
        if encoding is not None:
            # Not a FileResponse: it would honour a Range, and a range of a compressed file is not a range of the file.
            content = await run_in_threadpool(served.path.read_bytes)  # off the loop: the live relay shares it
            return Response(content=content, media_type=asset.media_type, headers=headers)
        return FileResponse(served.path, headers=headers, media_type=asset.media_type, stat_result=served.stat)
