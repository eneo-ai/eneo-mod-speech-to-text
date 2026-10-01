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

from fastapi import HTTPException, Request
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.config import Settings

TOO_LARGE = "Request body too large"
# The scope key that holds this request's limit, once the code that handles an upload has raised it.
BODY_LIMIT = "eneo_module.body_limit"
# No body is as long as 10**19 bytes, and int() refuses more than 4300 digits (a ValueError, so a 500).
_MAX_LENGTH_DIGITS = 19


def too_large(detail: str = TOO_LARGE) -> HTTPException:
    # Connection: close, so that a client that is still sending stops.
    return HTTPException(status_code=413, detail=detail, headers={"Connection": "close"})


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
                raise too_large()
        except HTTPException as error:
            await JSONResponse({"detail": error.detail}, status_code=error.status_code, headers=error.headers)(scope, receive, send)
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
                    raise too_large()
            return message

        await self.app(scope, counted_receive, send)
