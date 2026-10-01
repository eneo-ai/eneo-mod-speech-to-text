from __future__ import annotations

import asyncio
import contextlib
import enum
import logging
import re
import time
import unicodedata
from collections.abc import AsyncIterator
from http.cookiejar import DefaultCookiePolicy
from email.message import Message
from email.utils import collapse_rfc2231_value
from typing import Literal, NamedTuple
from urllib.parse import quote, unquote, urlsplit, urlunsplit
from uuid import UUID

import httpx
from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
from starlette.datastructures import UploadFile
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import (
    ConnectionClosed,
    ConnectionClosedError,
    InvalidHandshake,
)

from app.config import load_settings
from app.limits import BodyLimitMiddleware, allow_upload, declared_length, too_large
from app.module_auth import SESSION_COOKIE, ModuleAuth, eneo_is_unavailable

logger = logging.getLogger("eneo_proxy")
logging.basicConfig(level=logging.INFO)


settings = load_settings()

MIN_UPLOAD_PROXY_TIMEOUT_SECONDS = 60.0


# ---------- App ----------

@contextlib.asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    yield
    await http_client.aclose()


app = FastAPI(title="Eneo Speech-to-Text Module Backend", lifespan=lifespan)
app.add_middleware(BodyLimitMiddleware, settings=settings)


class _RefuseCookies(DefaultCookiePolicy):
    """Eneo's cookies are not a user's: the one client serves every user, so it stores none and sends none."""

    def set_ok(self, cookie, request) -> bool:
        return False

    def return_ok(self, cookie, request) -> bool:
        return False

    def domain_return_ok(self, domain, request) -> bool:
        return False

    def path_return_ok(self, path, request) -> bool:
        return False


http_client = httpx.AsyncClient(
    timeout=httpx.Timeout(60.0, connect=10.0),
    follow_redirects=False,
)
http_client.cookies.jar.set_policy(_RefuseCookies())
module_auth = ModuleAuth(settings=settings, http_client=http_client)
app.include_router(module_auth.router, prefix="/api/auth")


def _upload_timeout(timeout_seconds: float | None = None) -> httpx.Timeout:
    effective_timeout = settings.upload_proxy_timeout_seconds
    if timeout_seconds is not None:
        effective_timeout = min(
            settings.upload_proxy_timeout_seconds,
            max(MIN_UPLOAD_PROXY_TIMEOUT_SECONDS, timeout_seconds),
        )
    return httpx.Timeout(
        connect=10.0,
        read=effective_timeout,
        write=effective_timeout,
        pool=30.0,
    )


def _requested_upload_timeout_seconds(request: Request) -> float | None:
    raw = request.headers.get("x-upload-timeout-seconds")
    if raw is None:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if value > 0 else None


@app.get("/api/healthz")
async def healthz():
    return {"ok": True}


@app.get(
    "/api/config",
    dependencies=[Depends(module_auth.require_session)],
)
async def get_config():
    # The flow list's scope, decided by the auth mode in one place (Settings.flow_list_scope).
    return {"flow_list": settings.flow_list_scope}


# ---------- Branding ----------
# The organisation beside "Tal till text" is a deployment setting (Settings.organization). Neither
# route asks for a session: the login page shows the organisation before there is one.


@app.get("/api/branding")
async def get_branding():
    return {"organization": settings.organization}


@app.get("/api/branding/logo/{variant}")
async def get_branding_logo(variant: Literal["light", "dark"]) -> Response:
    logo = settings.organization_logo if variant == "light" else settings.organization_logo_dark
    if logo is None:
        raise HTTPException(status_code=404, detail="No logo is configured")
    return Response(
        content=logo.content,
        media_type=logo.media_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            # Revalidate every time: a replaced logo shows after the restart that loads it.
            "Cache-Control": "no-cache",
            # An SVG opened on its own, not through <img>, must run nothing in the module's origin.
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
    )


# ---------- Eneo proxy ----------

# Headers we should not forward from incoming request to upstream.
_HOP_BY_HOP_REQUEST_HEADERS = {
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "authorization",
    "cookie",
    "x-api-key",
    # Intern routing-header — Eneo ska inte se den.
    "x-space-id",
    # Intern proxy-budget för stora uploads.
    "x-upload-timeout-seconds",
    # The module checks the browser's origin itself; Eneo refuses any origin it does not list,
    # so the module's own hostname passed on would fail every write in production.
    "origin",
    "referer",
}
_HOP_BY_HOP_REQUEST_HEADERS.add(settings.eneo_api_key_header_name.lower())

# Headers we should not forward from upstream response back to client. Eneo's cookies are not the browser's:
# several would be merged into one line, and one named like the module's session would replace it. Its Location
# names Eneo's own host, which the browser cannot reach and which says how the network is laid out.
_UNFORWARDED_RESPONSE_HEADERS = {
    "content-encoding",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "content-length",
    "set-cookie",
    "location",
}

# The module never follows a redirect, and no route of it is expected to redirect, so one from Eneo is an error,
# not an answer for the browser. (304 is not one: If-None-Match is forwarded, and a conditional read gets it.)
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})


def _upstream_redirect() -> JSONResponse:
    return JSONResponse(
        status_code=502,
        content={
            "error": "upstream_redirect",
            "detail": "Eneo answered with a redirect, which the module does not follow.",
        },
    )

_RESOURCE_ID = r"[^/]+"
_PROXY_ROUTE_RULES: tuple[tuple[frozenset[str], re.Pattern[str]], ...] = (
    (frozenset({"GET"}), re.compile(r"flows/$")),
    (
        frozenset({"GET"}),
        re.compile(rf"flows/{_RESOURCE_ID}/(?:published|run-contract|graph)/$"),
    ),
    (frozenset({"GET", "POST"}), re.compile(rf"flows/{_RESOURCE_ID}/runs/$")),
    (
        frozenset({"GET"}),
        re.compile(rf"flows/{_RESOURCE_ID}/runs/{_RESOURCE_ID}/(?:status/)?$"),
    ),
    (
        frozenset({"GET"}),
        re.compile(rf"flows/{_RESOURCE_ID}/runs/{_RESOURCE_ID}/steps/$"),
    ),
    (
        frozenset({"GET"}),
        re.compile(
            rf"flows/{_RESOURCE_ID}/runs/{_RESOURCE_ID}/steps/"
            rf"{_RESOURCE_ID}/transcript-words/$"
        ),
    ),
    (
        frozenset({"GET"}),
        re.compile(rf"flows/{_RESOURCE_ID}/runs/{_RESOURCE_ID}/transcript-corrections/$"),
    ),
    (
        frozenset({"GET"}),
        re.compile(
            rf"flows/{_RESOURCE_ID}/runs/{_RESOURCE_ID}/steps/{_RESOURCE_ID}/"
            rf"attempts/{_RESOURCE_ID}/transcript-source/$"
        ),
    ),
    (
        frozenset({"PATCH"}),
        re.compile(
            rf"flows/{_RESOURCE_ID}/runs/{_RESOURCE_ID}/steps/"
            rf"{_RESOURCE_ID}/transcript-corrections/$"
        ),
    ),
    (
        frozenset({"POST"}),
        re.compile(
            rf"flows/{_RESOURCE_ID}/runs/{_RESOURCE_ID}/(?:cancel|redispatch|retry)/$"
        ),
    ),
    (
        # A new run from the reviewed transcript ("Skapa dokumentet igen med rättningarna").
        frozenset({"POST"}),
        re.compile(
            rf"flows/{_RESOURCE_ID}/runs/{_RESOURCE_ID}/steps/"
            rf"{_RESOURCE_ID}/transcript-regenerations/$"
        ),
    ),
    (
        frozenset({"POST"}),
        re.compile(
            rf"flows/{_RESOURCE_ID}/runs/{_RESOURCE_ID}/steps/"
            rf"{_RESOURCE_ID}/rerun/$"
        ),
    ),
    (
        frozenset({"GET"}),
        re.compile(
            rf"flows/{_RESOURCE_ID}/runs/{_RESOURCE_ID}/evidence/(?:export)?$"
        ),
    ),
    (
        frozenset({"GET"}),
        re.compile(
            rf"flows/{_RESOURCE_ID}/runs/{_RESOURCE_ID}/"
            r"review-checkpoints/active/$"
        ),
    ),
    (
        frozenset({"PATCH"}),
        re.compile(
            rf"flows/{_RESOURCE_ID}/runs/{_RESOURCE_ID}/review-checkpoints/"
            rf"{_RESOURCE_ID}/$"
        ),
    ),
    (
        frozenset({"POST"}),
        re.compile(
            rf"flows/{_RESOURCE_ID}/runs/{_RESOURCE_ID}/review-checkpoints/"
            rf"{_RESOURCE_ID}/(?:approve|reject|resume)/$"
        ),
    ),
    (
        frozenset({"GET"}),
        re.compile(rf"flows/{_RESOURCE_ID}/template-files/$"),
    ),
    (
        frozenset({"POST"}),
        re.compile(
            rf"flows/{_RESOURCE_ID}/template-files/{_RESOURCE_ID}/signed-url/$"
        ),
    ),
)


def _proxy_route_is_allowed(method: str, path: str) -> bool:
    return any(
        method in methods and pattern.fullmatch(path) is not None
        for methods, pattern in _PROXY_ROUTE_RULES
    )


def _resolve_proxy_path(method: str, path: str) -> str | None:
    """Return the allowlisted upstream path for ``path`` or None if not exposed.

    Eneo's routes carry a trailing slash, and the allowlist spells them that
    way. Next.js strips the trailing slash from rewritten paths in ``next
    dev`` (the dedicated upload routes already register both variants for the
    same reason), so a slash-stripped path is accepted when — and only when —
    its slash-suffixed form is allowlisted. Sending the canonical form upstream
    also avoids Eneo answering with a redirect the proxy would not follow.
    """
    if _proxy_route_is_allowed(method, path):
        return path
    canonical = f"{path}/"
    if not path.endswith("/") and _proxy_route_is_allowed(method, canonical):
        return canonical
    return None


_UNSAFE_CHARACTER = re.compile(r"[\x00-\x1f\x7f\\]")


def _leaves_route(path: str) -> bool:
    """True if ``path`` could reach another upstream route than the one authorized.

    The allowlist matches on the decoded path, but a percent-encoded dot
    segment such as ``%2E%2E`` still satisfies ``[^/]+`` and would let httpx
    resolve ``flows/../runs/`` to a different upstream path, and a decoded
    ``?`` or ``#`` would move the rest of the path into a query or fragment.
    A control character or a backslash is no part of an Eneo id either.
    Reject these before matching so the allowlist keeps meaning exactly the
    routes it spells out.
    """
    return (
        "?" in path
        or "#" in path
        or _UNSAFE_CHARACTER.search(path) is not None
        or any(unquote(segment) in {".", ".."} for segment in path.split("/"))
    )


# No URL the module sends is as long as this; one that would be is a request for no route of Eneo's.
_MAX_UPSTREAM_URL_LENGTH = 65_536


def _upstream_url(path: str) -> str:
    """``{ENEO_BACKEND_URL}/api/v1/{path}``, with each segment of ``path`` encoded as the one segment it is.

    ``path`` is the path as the module authorised it, already decoded once: a ``%2F`` in it is the three characters of
    an id, not a separator. httpx sends an escape it finds as it is, and Eneo decodes it once more, so
    ``flows/a%2Fexport/`` would arrive as ``flows/a/export/``, a route the allowlist never saw. Every character of a
    segment that is not a letter, a digit or one of ``_.-~`` is encoded here, ``%`` included. This is the one place
    an outbound Eneo URL is made from a path: the proxy, the uploads and the signed-URL requests all come through it.
    """
    url = f"{settings.eneo_backend_url}/api/v1/" + "/".join(quote(segment, safe="") for segment in path.split("/"))
    if len(url) > _MAX_UPSTREAM_URL_LENGTH:
        raise HTTPException(status_code=414, detail="The path is too long")
    return url


def _has_control_character(value: str | None) -> bool:
    return value is not None and any(character < " " or character == "\x7f" for character in value)


# Dedicated upload routes — bypass the catch-all proxy because forwarding
# the browser's raw multipart bytes triggers ReadError from Eneo's load balancer.
# We re-parse and rebuild the multipart with httpx instead.
async def _forward_upload(request: Request, path: str) -> Response:
    """Re-post the one file of the request's multipart body to Eneo's ``/api/v1/{path}``.

    Call it from a route that has no ``File(...)`` parameter: FastAPI reads a body before it runs a route's
    dependencies, and this reads it itself, so ``Depends(require_session)`` has run before a byte of it is read.
    The body must declare its Content-Length (411), at most ``settings.max_upload_bytes`` (413), and hold one file
    part named ``upload_file`` and no other part (400) whose file name and content type have no control character
    (400: a line break in either would be written into the part headers sent to Eneo). Nothing is left behind if
    the upload is cut off or refused.
    """
    # The path is built from decoded path params; a "." / ".." segment or
    # a "?" would resolve to a different Eneo route than the upload endpoints exposed.
    if _leaves_route(path):
        raise HTTPException(status_code=403, detail="Eneo resource is not exposed")
    upstream_url = _upstream_url(path)
    declared = declared_length(request.headers)
    if declared is None:
        raise HTTPException(status_code=411, detail="Content-Length required")
    if declared > settings.max_upload_bytes:
        raise too_large("Upload too large")
    # Only now, after the route's dependencies and these checks, is the body allowed to be as big as an upload; the
    # limit counts the bytes that arrive, so a Content-Length that lies gets no further than max_upload_bytes.
    allow_upload(request, settings.max_upload_bytes)
    # max_fields=0: no text field beside the file. The files are closed when the block ends, and by Starlette
    # if the parse fails.
    async with request.form(max_files=1, max_fields=0) as form:
        parts = form.multi_items()
        if len(parts) != 1 or parts[0][0] != "upload_file" or not isinstance(parts[0][1], UploadFile):
            raise HTTPException(status_code=400, detail="Exactly one file, named upload_file, is required")
        upload_file = parts[0][1]
        if _has_control_character(upload_file.filename) or _has_control_character(upload_file.content_type):
            raise HTTPException(
                status_code=400, detail="The file name and content type must not contain control characters"
            )
        return await _proxy_multipart_upload(
            upstream_url, upload_file, request, _requested_upload_timeout_seconds(request)
        )


async def _proxy_multipart_upload(
    upstream_url: str,
    upload_file: UploadFile,
    request: Request,
    timeout_seconds: float | None = None,
) -> Response:
    await upload_file.seek(0)
    try:
        upstream = await http_client.post(
            upstream_url,
            headers=module_auth.upstream_auth_headers(request),
            files={
                "upload_file": (
                    upload_file.filename,
                    upload_file.file,
                    upload_file.content_type or "application/octet-stream",
                )
            },
            timeout=_upload_timeout(timeout_seconds),
        )
    except httpx.TimeoutException:
        logger.exception("Upload timed out: url=%s", upstream_url)
        return JSONResponse(
            status_code=504,
            content={
                "error": "upstream_upload_timeout",
                "detail": "Eneo did not complete the upload before the timeout.",
            },
        )
    except httpx.RequestError:
        logger.exception("Upload failed: url=%s", upstream_url)
        return JSONResponse(
            status_code=502,
            content={
                "error": "upstream_unreachable",
                "detail": "Eneo could not be reached.",
            },
        )

    if upstream.status_code in _REDIRECT_STATUSES:
        logger.error("Upload was answered with a redirect: url=%s status=%s", upstream_url, upstream.status_code)
        return _upstream_redirect()

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
    )


@app.post(
    "/api/eneo/flows/{flow_id}/files",
    dependencies=[
        Depends(module_auth.require_session),
        Depends(module_auth.require_same_origin),
    ],
)
@app.post(
    "/api/eneo/flows/{flow_id}/files/",
    dependencies=[
        Depends(module_auth.require_session),
        Depends(module_auth.require_same_origin),
    ],
)
async def eneo_upload_file(flow_id: str, request: Request) -> Response:
    return await _forward_upload(request, f"flows/{flow_id}/files/")


@app.post(
    "/api/eneo/flows/{flow_id}/steps/{step_id}/runtime-files",
    dependencies=[
        Depends(module_auth.require_session),
        Depends(module_auth.require_same_origin),
    ],
)
@app.post(
    "/api/eneo/flows/{flow_id}/steps/{step_id}/runtime-files/",
    dependencies=[
        Depends(module_auth.require_session),
        Depends(module_auth.require_same_origin),
    ],
)
async def eneo_upload_step_runtime_file(flow_id: str, step_id: str, request: Request) -> Response:
    return await _forward_upload(request, f"flows/{flow_id}/steps/{step_id}/runtime-files/")


@app.post(
    "/api/eneo/flows/{flow_id}/template-files",
    dependencies=[
        Depends(module_auth.require_session),
        Depends(module_auth.require_same_origin),
    ],
)
@app.post(
    "/api/eneo/flows/{flow_id}/template-files/",
    dependencies=[
        Depends(module_auth.require_session),
        Depends(module_auth.require_same_origin),
    ],
)
async def eneo_upload_template_file(flow_id: str, request: Request) -> Response:
    return await _forward_upload(request, f"flows/{flow_id}/template-files/")


# ---------------------------------------------------------------------------
# Files of a run, streamed same-origin: audio for playback, artifacts to open
# or download.
#
# Eneo hands out a short-lived signed URL per file. The browser must not use it
# directly: the module's CSP only allows same-origin media and frames, and the
# URL is a bearer credential for the file. The module backend mints the URL
# with its own credentials, caches it per session for the file's lifetime so
# the browser's many Range requests do not each mint (and audit-log) a new
# one, and streams the bytes through with Range semantics intact.
# ---------------------------------------------------------------------------

_SIGNED_URL_TTL_SECONDS = 15 * 60
_SIGNED_URL_REFRESH_MARGIN_SECONDS = 60
_STREAM_FORWARD_REQUEST_HEADERS = frozenset({"range", "if-range", "accept"})
_STREAM_FORWARD_RESPONSE_HEADERS = frozenset(
    {
        "content-disposition",
        "content-type",
        "content-length",
        "content-range",
        "content-encoding",
        "accept-ranges",
        "etag",
        "last-modified",
    }
)


class _SignedUrl(NamedTuple):
    url: str
    expires_at: float


# Keyed by session and the Eneo path that mints the URL: one URL per file.
_signed_urls: dict[tuple[str, str], _SignedUrl] = {}


def _rebase_signed_url(signed_url: str, base_url: str) -> str:
    """Point a signed URL at the Eneo host the module backend can reach.

    Eneo builds signed URLs on its public base URL; on the module network the
    backend reaches Eneo on ``ENEO_BACKEND_URL`` instead. Only scheme and host
    change — the path and the signed query survive untouched.
    """
    signed = urlsplit(signed_url)
    base = urlsplit(base_url)
    return urlunsplit((base.scheme, base.netloc, signed.path, signed.query, ""))


def _prune_signed_urls(now: float) -> None:
    for key, entry in list(_signed_urls.items()):
        if entry.expires_at <= now:
            _signed_urls.pop(key, None)


async def _signed_url(request: Request, key: tuple[str, str], unavailable: str) -> str:
    now = time.time()
    cached = _signed_urls.get(key)
    if cached and cached.expires_at - _SIGNED_URL_REFRESH_MARGIN_SECONDS > now:
        return cached.url

    mint_path = key[1]
    try:
        upstream = await http_client.post(
            _upstream_url(mint_path),
            json={
                "expires_in": _SIGNED_URL_TTL_SECONDS,
                "content_disposition": "inline",
            },
            headers=module_auth.upstream_auth_headers(request),
        )
    except httpx.RequestError:
        logger.exception("Signed URL request failed: path=%s", mint_path)
        raise HTTPException(status_code=502, detail="Eneo could not be reached.")
    if upstream.status_code >= 400:
        try:
            detail = upstream.json()
        except ValueError:
            detail = {"detail": unavailable}
        raise HTTPException(status_code=upstream.status_code, detail=detail)

    payload = upstream.json()
    url = _rebase_signed_url(str(payload["url"]), settings.eneo_backend_url)
    expires_at = float(payload.get("expires_at") or now + _SIGNED_URL_TTL_SECONDS)
    _prune_signed_urls(now)
    _signed_urls[key] = _SignedUrl(url=url, expires_at=expires_at)
    return url


async def _stream_signed(
    request: Request, *resource: str, mint_path: str, unavailable: str
) -> Response:
    """Stream the file Eneo mints ``mint_path`` for; ``resource`` are the path ids."""
    if any(_leaves_route(part) for part in resource):
        raise HTTPException(status_code=403, detail="Eneo resource is not exposed")

    key = (request.cookies.get(SESSION_COOKIE) or "", mint_path)
    url = await _signed_url(request, key, unavailable)

    fwd_headers = {
        name: value
        for name, value in request.headers.items()
        if name.lower() in _STREAM_FORWARD_REQUEST_HEADERS
    }
    upstream_request = http_client.build_request("GET", url, headers=fwd_headers)
    try:
        upstream = await http_client.send(upstream_request, stream=True)
    except httpx.RequestError:
        logger.exception("File stream request failed: path=%s", mint_path)
        return JSONResponse(
            status_code=502,
            content={"error": "upstream_unreachable", "detail": "Eneo could not be reached."},
        )

    if upstream.status_code in _REDIRECT_STATUSES:
        # Not a file: the URL is not worth keeping either, and the stream is closed unread.
        _signed_urls.pop(key, None)
        await upstream.aclose()
        logger.error("File stream was answered with a redirect: path=%s status=%s", mint_path, upstream.status_code)
        return _upstream_redirect()

    if upstream.status_code >= 400:
        # A rejected token is not worth keeping around; the next request mints anew.
        _signed_urls.pop(key, None)
        try:
            body = await upstream.aread()
        finally:
            await upstream.aclose()
        detail: object = unavailable
        if upstream.headers.get("content-type", "").startswith("application/json"):
            try:
                detail = httpx.Response(200, content=body).json()
            except ValueError:
                pass
        raise HTTPException(status_code=upstream.status_code, detail=detail)

    resp_headers = {
        k: v
        for k, v in upstream.headers.items()
        if k.lower() in _STREAM_FORWARD_RESPONSE_HEADERS
    }
    resp_headers["Cache-Control"] = "private, no-store"
    return StreamingResponse(
        upstream.aiter_raw(),
        status_code=upstream.status_code,
        headers=resp_headers,
        background=BackgroundTask(upstream.aclose),
    )


async def _stream_input_file_audio(
    flow_id: str, run_id: str, file_id: str, request: Request
) -> Response:
    return await _stream_signed(
        request,
        flow_id,
        run_id,
        file_id,
        mint_path=f"flows/{flow_id}/runs/{run_id}/input-files/{file_id}/signed-url/",
        unavailable="Audio is not available for this run.",
    )


@app.get(
    "/api/eneo/flows/{flow_id}/runs/{run_id}/input-files/{file_id}/audio",
    dependencies=[Depends(module_auth.require_session)],
)
async def eneo_input_file_audio(
    flow_id: str, run_id: str, file_id: str, request: Request
) -> Response:
    return await _stream_input_file_audio(flow_id, run_id, file_id, request)


@app.get(
    "/api/eneo/flows/{flow_id}/runs/{run_id}/input-files/{file_id}/audio/",
    dependencies=[Depends(module_auth.require_session)],
)
async def eneo_input_file_audio_slash(
    flow_id: str, run_id: str, file_id: str, request: Request
) -> Response:
    return await _stream_input_file_audio(flow_id, run_id, file_id, request)


_UNSAFE_FILENAME = re.compile(r'[\x00-\x1f\x7f"\\/]+')


def _eneo_filename(header: str | None) -> str | None:
    """The name Eneo gave the file; its UTF-8 ``filename*`` wins over the ASCII fallback (RFC 6266)."""
    if not header:
        return None
    message = Message()
    message["content-disposition"] = header
    names = [value for key, value in message.get_params([], header="content-disposition") if key == "filename"]
    chosen = next((value for value in names if isinstance(value, tuple)), names[0] if names else None)
    return None if chosen is None else collapse_rfc2231_value(chosen)


def _safe_filename(name: str) -> str:
    return " ".join(_UNSAFE_FILENAME.sub(" ", name).split())


def _content_disposition(kind: str, filename: str | None) -> str:
    """``kind`` with Eneo's name, if any: an ASCII fallback and the UTF-8 original."""
    name = _safe_filename(filename or "")[:200]
    if not name:
        return kind
    # Sanitised again after NFKD, which folds a fullwidth quote or slash into its ASCII form.
    fallback = _safe_filename(unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()) or "fil"
    return f"{kind}; filename=\"{fallback}\"; filename*=UTF-8''{quote(name, safe='')}"


@app.get(
    "/api/eneo/flows/{flow_id}/runs/{run_id}/artifacts/{file_id}/content",
    dependencies=[Depends(module_auth.require_session)],
)
async def eneo_run_artifact_content(
    flow_id: str,
    run_id: str,
    file_id: str,
    request: Request,
    disposition: Literal["inline", "attachment"] = "attachment",
) -> Response:
    """A generated file under the name Eneo gave it: a PDF opens inline, anything else downloads."""
    response = await _stream_signed(
        request,
        flow_id,
        run_id,
        file_id,
        mint_path=f"flows/{flow_id}/runs/{run_id}/artifacts/{file_id}/signed-url/",
        unavailable="The file is not available for this run.",
    )
    media_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
    inline = disposition == "inline" and media_type == "application/pdf"
    response.headers["Content-Disposition"] = _content_disposition(
        "inline" if inline else "attachment",
        _eneo_filename(response.headers.get("content-disposition")),
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    if inline:
        # The result page previews the PDF in a dialog on the same origin.
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Content-Security-Policy"] = "frame-ancestors 'self'"
    return response


@app.api_route(
    "/api/eneo/{path:path}",
    methods=["GET", "POST", "PATCH"],
    dependencies=[
        Depends(module_auth.require_session),
        Depends(module_auth.require_same_origin),
    ],
)
async def eneo_proxy(path: str, request: Request) -> Response:
    resolved_path = (
        None if _leaves_route(path) else _resolve_proxy_path(request.method, path)
    )
    if resolved_path is None:
        raise HTTPException(status_code=403, detail="Eneo resource is not exposed")
    upstream_url = _upstream_url(resolved_path)
    # Forward request headers, but replace browser-controlled credentials with
    # the credentials owned by the configured module-auth session.
    fwd_headers: dict[str, str] = {}
    for name, value in request.headers.items():
        if name.lower() in _HOP_BY_HOP_REQUEST_HEADERS:
            continue
        fwd_headers[name] = value
    fwd_headers.update(module_auth.upstream_auth_headers(request))

    body = await request.body()

    try:
        upstream = await http_client.request(
            method=request.method,
            url=upstream_url,
            params=request.query_params,
            content=body if body else None,
            headers=fwd_headers,
        )
    except httpx.RequestError:
        logger.exception(
            "Upstream request failed: method=%s url=%s",
            request.method,
            upstream_url,
        )
        return JSONResponse(
            status_code=502,
            content={
                "error": "upstream_unreachable",
                "detail": "Eneo could not be reached.",
            },
        )

    if upstream.status_code in _REDIRECT_STATUSES:
        logger.error(
            "Eneo answered with a redirect: method=%s url=%s status=%s",
            request.method,
            upstream_url,
            upstream.status_code,
        )
        return _upstream_redirect()

    resp_headers = {
        k: v
        for k, v in upstream.headers.items()
        if k.lower() not in _UNFORWARDED_RESPONSE_HEADERS
    }

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=resp_headers,
        media_type=upstream.headers.get("content-type"),
    )


# ---------------------------------------------------------------------------
# Live transcription preview (Strömma).
#
# The browser streams its recording to /api/live/{flow_id}/{step_id}. The
# module backend asks Eneo for a single-use ticket with the user's module
# credentials, opens Eneo's live socket itself (so the ticket never reaches
# the browser and Eneo sees no browser Origin), and relays both ways
# unchanged: PCM frames and the stop message up, Eneo's JSON events down.
# The browser names its recording with ?recording_id=, which goes with the
# ticket request, so Eneo can keep a clean session's text for the run.
# Eneo owns the protocol and its limits; the relay only ends both sockets
# together.
# ---------------------------------------------------------------------------

_LIVE_SUBPROTOCOL = "eneo-live.v1"
_LIVE_CLOSE_TIMEOUT_SECONDS = 2
# A socket that accepts no write for this long has stopped reading, and the
# relay ends the session. Longer than Eneo's own 10 s deadline toward the model
# server, so when that is what stalled, Eneo's typed error arrives first.
_LIVE_SEND_TIMEOUT_SECONDS = 15
# transcript.done repeats the session's whole text; Eneo bounds the messages
# it reads from the model server the same way.
_LIVE_MAX_MESSAGE_BYTES = 8 * 2**20
# Eneo's pattern for a recording id; without a valid one the session is a
# preview only.
_LIVE_RECORDING_ID = re.compile(r"[A-Za-z0-9_-]{8,64}")


class _LiveTicket(BaseModel):
    ticket: str
    # A path on Eneo's host; anything else would send the ticket elsewhere.
    websocket_path: str = Field(pattern=r"^/")


class _EneoError(BaseModel):
    code: str = "upstream_error"
    message: str = "Eneo refused the live transcription session."


class _LiveRefused(Exception):
    """The session cannot start; the browser gets this one error event."""

    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.event = {
            "type": "error",
            "code": code,
            "message": message,
            "retryable": retryable,
        }


def _eneo_unreachable() -> _LiveRefused:
    return _LiveRefused(
        "upstream_unreachable", "Eneo could not be reached.", retryable=True
    )


async def _open_live_session(
    websocket: WebSocket, flow_id: UUID, step_id: UUID
) -> ClientConnection:
    recording_id = websocket.query_params.get("recording_id", "")
    try:
        response = await http_client.post(
            _upstream_url(f"flows/{flow_id}/steps/{step_id}/live-transcription-sessions/"),
            headers=module_auth.upstream_auth_headers(websocket),
            json=(
                {"recording_id": recording_id}
                if _LIVE_RECORDING_ID.fullmatch(recording_id)
                else None
            ),
            timeout=httpx.Timeout(10.0),
        )
    except httpx.RequestError:
        logger.warning("Live transcription ticket: Eneo unreachable", exc_info=True)
        raise _eneo_unreachable() from None
    if response.status_code >= 400:
        try:
            error = _EneoError.model_validate(response.json())
        except ValueError:
            error = _EneoError()
        raise _LiveRefused(
            error.code,
            error.message,
            retryable=eneo_is_unavailable(response.status_code),
        )
    try:
        ticket = _LiveTicket.model_validate(response.json())
    except ValueError:
        logger.exception("Live transcription ticket: invalid response from Eneo")
        raise _eneo_unreachable() from None
    try:
        return await connect(
            re.sub(r"^http", "ws", settings.eneo_backend_url) + ticket.websocket_path,
            subprotocols=[_LIVE_SUBPROTOCOL, f"ticket.{ticket.ticket}"],
            close_timeout=_LIVE_CLOSE_TIMEOUT_SECONDS,
            max_size=_LIVE_MAX_MESSAGE_BYTES,
        )
    except (OSError, TimeoutError, InvalidHandshake):
        logger.warning("Live transcription socket: Eneo refused it", exc_info=True)
        raise _eneo_unreachable() from None


class _PumpEnd(enum.Enum):
    """Why a relay pump stopped."""

    BROWSER_GONE = enum.auto()  # the browser left or stopped reading
    ENEO_ENDED = enum.auto()  # Eneo closed its socket, normally or not
    ENEO_STALLED = enum.auto()  # a write to Eneo timed out


async def _browser_to_eneo(browser: WebSocket, eneo: ClientConnection) -> _PumpEnd:
    """Send the browser's frames to Eneo until one side ends."""
    while True:
        message = await browser.receive()
        if message["type"] == "websocket.disconnect":
            return _PumpEnd.BROWSER_GONE
        frame = message.get("bytes")
        try:
            await asyncio.wait_for(
                eneo.send(frame if frame is not None else message["text"]),
                _LIVE_SEND_TIMEOUT_SECONDS,
            )
        except ConnectionClosed:
            return _PumpEnd.ENEO_ENDED
        except TimeoutError:
            return _PumpEnd.ENEO_STALLED


async def _eneo_to_browser(eneo: ClientConnection, browser: WebSocket) -> _PumpEnd:
    """Send Eneo's events to the browser until one side ends."""
    try:
        async for message in eneo:
            if isinstance(message, bytes):
                sent = browser.send_bytes(message)
            else:
                sent = browser.send_text(message)
            await asyncio.wait_for(sent, _LIVE_SEND_TIMEOUT_SECONDS)
    except ConnectionClosedError:
        pass  # Eneo's socket broke; its close code says so
    except (TimeoutError, WebSocketDisconnect, RuntimeError):
        return _PumpEnd.BROWSER_GONE
    return _PumpEnd.ENEO_ENDED


async def _relay_live_session(browser: WebSocket, eneo: ClientConnection) -> int:
    """Relay both ways until one side ends; returns the browser's close code."""
    upstream = asyncio.create_task(_browser_to_eneo(browser, eneo))
    downstream = asyncio.create_task(_eneo_to_browser(eneo, browser))
    try:
        done, _ = await asyncio.wait(
            {upstream, downstream}, return_when=asyncio.FIRST_COMPLETED
        )
        ends = {pump.result() for pump in done}
        if _PumpEnd.BROWSER_GONE in ends:
            return 1011  # stop at once
        # Eneo ended or stalled. Stop reading the browser and close Eneo, so
        # nothing new arrives, then deliver the events Eneo sent before.
        upstream.cancel()
        await _close_eneo_socket(eneo)
        ends.add(await downstream)
        # 1000 only when Eneo ended the session itself, closing with 1000 after
        # `transcript.done` or an `error`, and every event reached the browser;
        # a close that completes after the relay gave up does not count.
        if ends == {_PumpEnd.ENEO_ENDED} and eneo.close_code == 1000:
            return 1000
        return 1011
    finally:
        for pump in (upstream, downstream):
            pump.cancel()
        await asyncio.gather(upstream, downstream, return_exceptions=True)


async def _close_eneo_socket(eneo: ClientConnection) -> None:
    # close() first flushes its close frame, which a peer that stopped reading
    # never takes, and only then applies its own timeout.
    try:
        await asyncio.wait_for(eneo.close(), _LIVE_CLOSE_TIMEOUT_SECONDS)
    except TimeoutError:
        eneo.transport.abort()


async def _close_browser_socket(
    websocket: WebSocket, *, code: int = 1000, event: dict[str, object] | None = None
) -> None:
    """Send the last event, if any, and close; the browser may be gone already.

    uvicorn bounds the close itself: a close frame the browser does not take
    within its close timeout drops the connection.
    """
    if event is not None:
        with contextlib.suppress(TimeoutError, WebSocketDisconnect, RuntimeError):
            await asyncio.wait_for(websocket.send_json(event), _LIVE_SEND_TIMEOUT_SECONDS)
    with contextlib.suppress(WebSocketDisconnect, RuntimeError):
        await websocket.close(code)


@app.websocket(
    "/api/live/{flow_id}/{step_id}",
    dependencies=[
        Depends(module_auth.require_same_origin),
        Depends(module_auth.require_session),
    ],
)
async def live_transcription(websocket: WebSocket, flow_id: UUID, step_id: UUID) -> None:
    await websocket.accept()
    try:
        eneo = await _open_live_session(websocket, flow_id, step_id)
    except _LiveRefused as refused:
        await _close_browser_socket(websocket, event=refused.event)
        return
    try:
        code = await _relay_live_session(websocket, eneo)
    finally:
        await _close_eneo_socket(eneo)
    await _close_browser_socket(websocket, code=code)
