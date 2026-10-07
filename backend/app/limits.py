"""How much of a request body the module reads.

No body is read before the route's own dependencies have run, and none past a limit. One pure-ASGI middleware holds
it for the whole app, whatever route or content type:

- Every request body is capped at ``Settings.max_body_bytes``: 413 at once if its length is declared above the cap, and
  413 as soon as the stream passes it. It looks at no session, so it holds for the public ``POST /api/auth/login`` too,
  and it answers before FastAPI parses a JSON body into a model (FastAPI does that before it runs a route's
  dependencies, and reads a body whatever the content type says: a content type is the client's claim, so none is
  exempt).
- ``allow_upload`` raises the limit to ``Settings.max_upload_bytes`` for one request, after the route's dependencies
  have run and its own length checks have passed. The count is of the bytes that arrive, so a Content-Length that
  lies, or a chunked body, gets no further.
- A Content-Length that is not a plain number of reasonable length is 400, before any route sees it.

The limits are read from the settings at each request, so the settings are the one place they are held.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import anyio
from fastapi import HTTPException, Request
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.config import Settings

# What the browser's live socket may send the module, in every way the module is started (app.serve passes it):
# Eneo's PCM frames are at most 64 KiB, so a message of 128 KiB fits one. A larger frame closes the socket with 1009.
# There is no limit on a connection's queue because uvicorn's default implementation needs none: it stops reading as soon
# as a message is queued, until the app has taken it (test_live_relay.py pins that).
WS_MAX_MESSAGE_BYTES = 128 * 1024

# Reserve multipart framing when a raw file is later forwarded to Eneo.
UPLOAD_ENVELOPE_BYTES = 4096

TOO_LARGE = "Request body too large"
UPLOAD_TOO_LARGE = "Upload too large: the module accepts at most max_upload_bytes (MAX_UPLOAD_BYTES), which is not Eneo's own limit"
# The scope key that holds this request's limit, once the code that handles an upload has raised it.
BODY_LIMIT = "eneo_module.body_limit"
# No body is as long as 10**19 bytes, and int() refuses more than 4300 digits (a ValueError, so a 500).
_MAX_LENGTH_DIGITS = 19


@contextmanager
def capacity_slot(limiter: anyio.CapacityLimiter) -> Iterator[bool]:
    """Refuse excess work without queueing; release only after the caller's resource cleanup."""
    borrower = object()
    try:
        limiter.acquire_on_behalf_of_nowait(borrower)
    except anyio.WouldBlock:
        yield False
        return
    try:
        yield True
    finally:
        limiter.release_on_behalf_of(borrower)


class BodyTooLarge(HTTPException):
    """413 whose body also says which limit of the module was passed, and how many bytes it is.

    Eneo has limits of its own (a flow's max_file_size_bytes, answered 413 too); ``max_body_bytes`` or
    ``max_upload_bytes`` in the body says this one is the module's.
    """

    def __init__(self, detail: str, limit_name: str, limit: int) -> None:
        # Connection: close, so that a client that is still sending stops.
        super().__init__(status_code=413, detail=detail, headers={"Connection": "close"})
        self.body = {"detail": detail, limit_name: limit}


async def body_too_large_handler(request: Request, error: BodyTooLarge) -> JSONResponse:
    return JSONResponse(error.body, status_code=413, headers=error.headers)


def too_large(settings: Settings, *, upload: bool) -> BodyTooLarge:
    """The 413 for a body past the module's limit for an upload, or for any other body."""
    if upload:
        return BodyTooLarge(UPLOAD_TOO_LARGE, "max_upload_bytes", settings.max_upload_bytes)
    return BodyTooLarge(TOO_LARGE, "max_body_bytes", settings.max_body_bytes)


def declared_length(headers: Headers) -> int | None:
    """The Content-Length a request declares, or None if it has none; 400 if it is not a plain number."""
    value = headers.get("content-length")
    if value is None:
        return None
    if not (value.isascii() and value.isdigit() and len(value) <= _MAX_LENGTH_DIGITS):
        # Close the connection too: where this request ends is not known.
        raise HTTPException(status_code=400, detail="Invalid Content-Length", headers={"Connection": "close"})
    return int(value)


def allow_upload(request: Request, limit: int) -> None:
    """Let this request's body be ``limit`` bytes (not the default): called by the code that reads an upload."""
    request.scope[BODY_LIMIT] = limit


class BodyLimitMiddleware:
    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        # A length above this is refused whatever route it is for: only a multipart upload may be as big as an
        # upload, and a body that claims to be one still has to get through the count below.
        multipart = headers.get("content-type", "").lower().startswith("multipart/form-data")
        ceiling = self.settings.max_upload_bytes if multipart else self.settings.max_body_bytes
        try:
            declared = declared_length(headers)
            if declared is not None and declared > ceiling:
                raise too_large(self.settings, upload=multipart)
        except HTTPException as error:
            body = error.body if isinstance(error, BodyTooLarge) else {"detail": error.detail}
            await JSONResponse(body, status_code=error.status_code, headers=error.headers)(scope, receive, send)
            return
        received = 0

        async def counted_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > scope.get(BODY_LIMIT, self.settings.max_body_bytes):
                    # An HTTPException, not a private error: FastAPI turns any other exception raised while it
                    # reads a body into a 400.
                    raise too_large(self.settings, upload=BODY_LIMIT in scope)
            return message

        await self.app(scope, counted_receive, send)
