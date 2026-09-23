from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import NamedTuple
from urllib.parse import unquote, urlsplit, urlunsplit
from uuid import UUID

import httpx
from fastapi import (
    Depends,
    FastAPI,
    File,
    HTTPException,
    Request,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import InvalidHandshake

from app.config import load_settings
from app.module_auth import SESSION_COOKIE, ModuleAuth, eneo_is_unavailable

logger = logging.getLogger("eneo_proxy")
logging.basicConfig(level=logging.INFO)


settings = load_settings()

MIN_UPLOAD_PROXY_TIMEOUT_SECONDS = 60.0


# ---------- App ----------

app = FastAPI(title="Eneo Speech-to-Text Module Backend")
http_client = httpx.AsyncClient(
    timeout=httpx.Timeout(60.0, connect=10.0),
    follow_redirects=False,
)
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


@app.on_event("shutdown")
async def _shutdown() -> None:
    await http_client.aclose()


@app.get("/api/healthz")
async def healthz():
    return {"ok": True}


@app.get(
    "/api/config",
    dependencies=[Depends(module_auth.require_session)],
)
async def get_config():
    return {
        "demo_space_id": settings.demo_space_id,
        "demo_space_name": settings.demo_space_name,
        "demo_space_ids": (
            [settings.demo_space_id] if settings.demo_space_id is not None else []
        ),
    }


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
}
_HOP_BY_HOP_REQUEST_HEADERS.add(settings.eneo_api_key_header_name.lower())

# Headers we should not forward from upstream response back to client.
_HOP_BY_HOP_RESPONSE_HEADERS = {
    "content-encoding",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "content-length",
}

_RESOURCE_ID = r"[^/]+"
_PROXY_ROUTE_RULES: tuple[tuple[frozenset[str], re.Pattern[str]], ...] = (
    (frozenset({"GET"}), re.compile(rf"spaces/$|spaces/{_RESOURCE_ID}/$")),
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
        frozenset({"PATCH"}),
        re.compile(
            rf"flows/{_RESOURCE_ID}/runs/{_RESOURCE_ID}/steps/"
            rf"{_RESOURCE_ID}/transcript-corrections/$"
        ),
    ),
    (
        frozenset({"POST"}),
        re.compile(
            rf"flows/{_RESOURCE_ID}/runs/{_RESOURCE_ID}/artifacts/"
            rf"{_RESOURCE_ID}/signed-url/$"
        ),
    ),
    (
        frozenset({"POST"}),
        re.compile(
            rf"flows/{_RESOURCE_ID}/runs/{_RESOURCE_ID}/(?:cancel|redispatch)/$"
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


def _has_dot_segment(path: str) -> bool:
    """True if any path segment decodes to "." or ".." (a traversal segment).

    The allowlist matches on the decoded path, but a percent-encoded dot
    segment such as ``%2E%2E`` still satisfies ``[^/]+`` and would let httpx
    resolve ``flows/../runs/`` to a different upstream path than the one that
    was authorized. Reject these before matching so the allowlist keeps
    meaning exactly the routes it spells out.
    """
    return any(unquote(segment) in {".", ".."} for segment in path.split("/"))


# Dedicated upload routes — bypass the catch-all proxy because forwarding
# the browser's raw multipart bytes triggers ReadError from Eneo's load balancer.
# We re-parse and rebuild the multipart with httpx instead.
async def _proxy_multipart_upload(
    upstream_url: str,
    upload_file: UploadFile,
    request: Request,
    timeout_seconds: float | None = None,
) -> Response:
    # Upstream URLs are built from decoded path params; a "." / ".." segment
    # would resolve to a different Eneo route than the upload endpoints exposed.
    if _has_dot_segment(upstream_url):
        raise HTTPException(status_code=403, detail="Eneo resource is not exposed")
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
async def eneo_upload_file(
    flow_id: str,
    request: Request,
    upload_file: UploadFile = File(...),
) -> Response:
    upstream_url = f"{settings.eneo_backend_url}/api/v1/flows/{flow_id}/files/"
    return await _proxy_multipart_upload(
        upstream_url,
        upload_file,
        request,
        _requested_upload_timeout_seconds(request),
    )


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
async def eneo_upload_step_runtime_file(
    flow_id: str,
    step_id: str,
    request: Request,
    upload_file: UploadFile = File(...),
) -> Response:
    upstream_url = (
        f"{settings.eneo_backend_url}/api/v1/flows/{flow_id}"
        f"/steps/{step_id}/runtime-files/"
    )
    return await _proxy_multipart_upload(
        upstream_url,
        upload_file,
        request,
        _requested_upload_timeout_seconds(request),
    )


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
async def eneo_upload_template_file(
    flow_id: str,
    request: Request,
    upload_file: UploadFile = File(...),
) -> Response:
    upstream_url = (
        f"{settings.eneo_backend_url}/api/v1/flows/{flow_id}/template-files/"
    )
    return await _proxy_multipart_upload(
        upstream_url,
        upload_file,
        request,
        _requested_upload_timeout_seconds(request),
    )


# ---------------------------------------------------------------------------
# Audio playback for a run's input files.
#
# Eneo hands out a short-lived signed URL per input file. The browser must not
# use it directly: the module's CSP only allows same-origin media, and the URL
# is a bearer credential for the file. The module backend mints the URL with
# its own credentials, caches it per session for the file's lifetime so the
# browser's many Range requests do not each mint (and audit-log) a new one,
# and streams the bytes through with Range semantics intact.
# ---------------------------------------------------------------------------

_AUDIO_SIGNED_URL_TTL_SECONDS = 15 * 60
_AUDIO_SIGNED_URL_REFRESH_MARGIN_SECONDS = 60
_AUDIO_FORWARD_REQUEST_HEADERS = frozenset({"range", "if-range", "accept"})
_AUDIO_FORWARD_RESPONSE_HEADERS = frozenset(
    {
        "content-type",
        "content-length",
        "content-range",
        "content-encoding",
        "accept-ranges",
        "etag",
        "last-modified",
    }
)


class _SignedAudioUrl(NamedTuple):
    url: str
    expires_at: float


_signed_audio_urls: dict[tuple[str, str, str, str], _SignedAudioUrl] = {}


def _rebase_signed_url(signed_url: str, base_url: str) -> str:
    """Point a signed URL at the Eneo host the module backend can reach.

    Eneo builds signed URLs on its public base URL; on the module network the
    backend reaches Eneo on ``ENEO_BACKEND_URL`` instead. Only scheme and host
    change — the path and the signed query survive untouched.
    """
    signed = urlsplit(signed_url)
    base = urlsplit(base_url)
    return urlunsplit((base.scheme, base.netloc, signed.path, signed.query, ""))


def _prune_signed_audio_urls(now: float) -> None:
    for key, entry in list(_signed_audio_urls.items()):
        if entry.expires_at <= now:
            _signed_audio_urls.pop(key, None)


async def _signed_audio_url(
    request: Request, key: tuple[str, str, str, str]
) -> str:
    now = time.time()
    cached = _signed_audio_urls.get(key)
    if cached and cached.expires_at - _AUDIO_SIGNED_URL_REFRESH_MARGIN_SECONDS > now:
        return cached.url

    _, flow_id, run_id, file_id = key
    try:
        upstream = await http_client.post(
            f"{settings.eneo_backend_url}/api/v1/flows/{flow_id}/runs/{run_id}"
            f"/input-files/{file_id}/signed-url/",
            json={
                "expires_in": _AUDIO_SIGNED_URL_TTL_SECONDS,
                "content_disposition": "inline",
            },
            headers=module_auth.upstream_auth_headers(request),
        )
    except httpx.RequestError:
        logger.exception("Signed audio URL request failed: run=%s file=%s", run_id, file_id)
        raise HTTPException(status_code=502, detail="Eneo could not be reached.")
    if upstream.status_code >= 400:
        try:
            detail = upstream.json()
        except ValueError:
            detail = {"detail": "Audio is not available for this run."}
        raise HTTPException(status_code=upstream.status_code, detail=detail)

    payload = upstream.json()
    url = _rebase_signed_url(str(payload["url"]), settings.eneo_backend_url)
    expires_at = float(payload.get("expires_at") or now + _AUDIO_SIGNED_URL_TTL_SECONDS)
    _prune_signed_audio_urls(now)
    _signed_audio_urls[key] = _SignedAudioUrl(url=url, expires_at=expires_at)
    return url


async def _stream_input_file_audio(
    flow_id: str, run_id: str, file_id: str, request: Request
) -> Response:
    if any(_has_dot_segment(part) for part in (flow_id, run_id, file_id)):
        raise HTTPException(status_code=403, detail="Eneo resource is not exposed")

    session_id = request.cookies.get(SESSION_COOKIE) or ""
    key = (session_id, flow_id, run_id, file_id)
    url = await _signed_audio_url(request, key)

    fwd_headers = {
        name: value
        for name, value in request.headers.items()
        if name.lower() in _AUDIO_FORWARD_REQUEST_HEADERS
    }
    upstream_request = http_client.build_request("GET", url, headers=fwd_headers)
    try:
        upstream = await http_client.send(upstream_request, stream=True)
    except httpx.RequestError:
        logger.exception("Audio stream request failed: run=%s file=%s", run_id, file_id)
        return JSONResponse(
            status_code=502,
            content={"error": "upstream_unreachable", "detail": "Eneo could not be reached."},
        )

    if upstream.status_code >= 400:
        # A rejected token is not worth keeping around; the next request mints anew.
        _signed_audio_urls.pop(key, None)
        try:
            body = await upstream.aread()
        finally:
            await upstream.aclose()
        detail: object = "Audio is not available for this run."
        if upstream.headers.get("content-type", "").startswith("application/json"):
            try:
                detail = httpx.Response(200, content=body).json()
            except ValueError:
                pass
        raise HTTPException(status_code=upstream.status_code, detail=detail)

    resp_headers = {
        k: v
        for k, v in upstream.headers.items()
        if k.lower() in _AUDIO_FORWARD_RESPONSE_HEADERS
    }
    resp_headers["Cache-Control"] = "private, no-store"
    return StreamingResponse(
        upstream.aiter_raw(),
        status_code=upstream.status_code,
        headers=resp_headers,
        background=BackgroundTask(upstream.aclose),
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
        None if _has_dot_segment(path) else _resolve_proxy_path(request.method, path)
    )
    if resolved_path is None:
        raise HTTPException(status_code=403, detail="Eneo resource is not exposed")
    upstream_url = f"{settings.eneo_backend_url}/api/v1/{resolved_path}"
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

    resp_headers = {
        k: v
        for k, v in upstream.headers.items()
        if k.lower() not in _HOP_BY_HOP_RESPONSE_HEADERS
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
# Eneo owns the protocol and its limits; the relay only ends both sockets
# together.
# ---------------------------------------------------------------------------

_LIVE_SUBPROTOCOL = "eneo-live.v1"
_LIVE_CLOSE_TIMEOUT_SECONDS = 2
# transcript.done repeats the session's whole text; Eneo bounds the messages
# it reads from the model server the same way.
_LIVE_MAX_MESSAGE_BYTES = 8 * 2**20


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
    try:
        response = await http_client.post(
            f"{settings.eneo_backend_url}/api/v1/flows/{flow_id}/steps/{step_id}"
            "/live-transcription-sessions/",
            headers=module_auth.upstream_auth_headers(websocket),
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


async def _relay_live_session(browser: WebSocket, eneo: ClientConnection) -> None:
    """Relay frames both ways until either side ends."""

    async def upstream() -> None:
        while True:
            message = await browser.receive()
            if message["type"] == "websocket.disconnect":
                return
            frame = message.get("bytes")
            await eneo.send(frame if frame is not None else message["text"])

    async def downstream() -> None:
        async for message in eneo:
            if isinstance(message, bytes):
                await browser.send_bytes(message)
            else:
                await browser.send_text(message)

    pumps = [asyncio.create_task(upstream()), asyncio.create_task(downstream())]
    try:
        await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for pump in pumps:
            pump.cancel()
        await asyncio.gather(*pumps, return_exceptions=True)


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
    """Send the last event, if any, and close; the browser may be gone already."""
    try:
        if event is not None:
            await websocket.send_json(event)
        await websocket.close(code)
    except (WebSocketDisconnect, RuntimeError):
        pass


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
        await _relay_live_session(websocket, eneo)
    finally:
        await _close_eneo_socket(eneo)
    # Eneo ends a session with 1000 after `transcript.done` or an `error`;
    # anything else means its socket broke.
    code = 1000 if eneo.close_code == 1000 else 1011
    await _close_browser_socket(websocket, code=code)
