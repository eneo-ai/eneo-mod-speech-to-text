"""The backend as a web server: the security headers on every response (this file), and the built UI (B1.3, B1.4).

Adapted from the module kit's packages/bff/src/eneo_module_bff/web.py (kit commit 6621163): the ``setdefault``
precedence and the shape of the header set are the kit's; the mechanism is not (a pure-ASGI middleware, because the
kit's ``@app.middleware`` is Starlette's BaseHTTPMiddleware, which wraps the body of a streamed answer: this app streams
audio and PDFs and must close its upstream when the browser leaves) and neither is the ``Permissions-Policy`` (the kit's
empty microphone allowlist would stop the recording). Plan C (the module kit) deletes this copy.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse
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
