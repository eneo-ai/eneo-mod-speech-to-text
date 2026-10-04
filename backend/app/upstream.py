"""The one HTTP client the module uses to reach Eneo, and how it is built.

One client serves every user, and every call carries the service key. So it keeps no cookie (one Eneo sets on a
user's call would be sent with the next user's), and it reads no answer past a bound.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from http.cookiejar import DefaultCookiePolicy

import httpx

from app.config import Settings

# The request extension that sets how much of that request's answer is read: a number of bytes, or None for none (a
# file that streams). A request without it gets ``Settings.max_response_bytes``.
LIMIT = "eneo_module.max_response_bytes"
# For the answers that carry a token or a URL, and the body of a failed file answer: a few lines of JSON, never more.
SMALL_ANSWER_BYTES = 1024 * 1024
SMALL_ANSWER = {LIMIT: SMALL_ANSWER_BYTES}
STREAMED = {LIMIT: None}
# How long Eneo has to accept a connection, and, for a call that carries a token or a ticket and gets a few lines back
# (the login, a refresh, a live ticket), to answer at all: it does either well within this or is not there.
CONNECT_TIMEOUT_SECONDS = 10.0
SMALL_CALL_TIMEOUT = httpx.Timeout(CONNECT_TIMEOUT_SECONDS)


class UnboundedAnswer(httpx.TransportError):
    """An answer whose size the module will not read: past its bound, or encoded, so that its decoded size is not known."""


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


class _Counted(httpx.AsyncByteStream):
    """The body of an answer, until it has passed ``limit`` bytes."""

    def __init__(self, stream: httpx.AsyncByteStream, limit: int, request: httpx.Request) -> None:
        self._stream, self._limit, self._request, self._seen = stream, limit, request, 0

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in self._stream:
            self._seen += len(chunk)
            if self._seen > self._limit:
                raise UnboundedAnswer(f"The answer is longer than {self._limit} bytes", request=self._request)
            yield chunk

    async def aclose(self) -> None:
        await self._stream.aclose()


def make_client(settings: Settings) -> httpx.AsyncClient:
    """The client the app uses for every call to Eneo.

    No answer is read past a bound (``Settings.max_response_bytes``, read at each answer, or the request's own
    ``LIMIT``), counted while it arrives, and the answer is closed past it: ``UnboundedAnswer``, a ``RequestError``.
    The module asks for no encoding and refuses an encoded answer, so what is counted is what would be held (a few KB
    of gzip can decode to gigabytes). A request with ``LIMIT`` None is a file that streams.
    """

    async def bound(response: httpx.Response) -> None:
        request = response.request
        limit = request.extensions.get(LIMIT, settings.max_response_bytes)
        if limit is None:
            return
        # These answers carry no content whatever their headers say: a 304's Content-Length and Content-Encoding
        # describe the representation it stands for (RFC 9110), and so do a HEAD's. No byte of them is read.
        if request.method == "HEAD" or response.status_code < 200 or response.status_code in {204, 304}:
            return
        if response.headers.get("content-encoding", "identity").strip().lower() not in {"", "identity"}:
            raise UnboundedAnswer("The answer is encoded, and its decoded size is not known", request=request)
        declared = response.headers.get("content-length", "")
        if declared.isascii() and declared.isdigit() and (len(declared) > 18 or int(declared) > limit):
            raise UnboundedAnswer(f"The answer declares {declared} bytes, more than {limit}", request=request)
        response.stream = _Counted(response.stream, limit, request)

    client = httpx.AsyncClient(
        timeout=httpx.Timeout(60.0, connect=CONNECT_TIMEOUT_SECONDS),
        follow_redirects=False,
        headers={"Accept-Encoding": "identity"},
        event_hooks={"response": [bound]},
    )
    client.cookies.jar.set_policy(_RefuseCookies())
    return client
