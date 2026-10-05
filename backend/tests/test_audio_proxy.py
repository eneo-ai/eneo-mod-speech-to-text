import asyncio
import contextlib
import os
import time
import unittest

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "http://localhost:3002")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")

import anyio  # noqa: E402
import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.module_auth import (  # noqa: E402
    EneoSsoSession,
    ModuleUser,
    SESSION_COOKIE,
)

SIGNED = "https://eneo.example.test/api/v1/files/file-1/download/?token=abc"


class FakeSignedUrlResponse:
    status_code = 200

    def json(self):
        return {"url": SIGNED, "expires_at": int(time.time()) + 900}


class FakeStreamResponse:
    def __init__(self, status_code: int, headers: dict[str, str], body: bytes) -> None:
        self.status_code = status_code
        self.headers = httpx.Headers(headers)
        self._body = body
        self.closed = False

    async def aiter_raw(self):
        yield self._body

    async def aclose(self):
        self.closed = True


class ScriptedStream(FakeStreamResponse):
    """A body of ``chunks`` that then ends, breaks or stalls. Only the module's own cleanup closes it: a real transport's
    stream may close itself on an error, and the module does not rely on that."""

    def __init__(self, chunks: list[bytes], then: str = "ends") -> None:
        super().__init__(200, {"content-type": "audio/webm"}, b"")
        self.chunks, self.then = chunks, then

    async def aiter_raw(self):
        for chunk in self.chunks:
            yield chunk
        if self.then == "breaks":
            raise httpx.ReadError("the connection broke")
        if self.then == "stalls":
            await asyncio.Event().wait()


class FakeAudioClient:
    def __init__(self) -> None:
        self.signed_url_calls: list[dict[str, object]] = []
        self.stream_requests: list[httpx.Request] = []
        self.response: FakeStreamResponse | None = None  # what the next file request gets, when a test sets one

    async def post(self, url, **kwargs):
        self.signed_url_calls.append({"url": url, **kwargs})
        return FakeSignedUrlResponse()

    def build_request(self, method, url, headers=None, extensions=None):
        return httpx.Request(method, url, headers=headers, extensions=extensions)

    async def send(self, request, stream=False):
        self.stream_requests.append(request)
        if self.response is not None:
            return self.response
        if "range" in request.headers:
            return FakeStreamResponse(
                206,
                {
                    "content-type": "audio/webm",
                    "content-range": "bytes 0-3/10",
                    "content-length": "4",
                    "accept-ranges": "bytes",
                    "set-cookie": "leak=1",
                },
                b"abcd",
            )
        return FakeStreamResponse(
            200,
            {"content-type": "audio/webm", "content-length": "10"},
            b"0123456789",
        )


class AudioProxyCase(unittest.TestCase):
    def setUp(self) -> None:
        self.original_client = main.http_client
        self.fake = FakeAudioClient()
        main.http_client = self.fake
        main._signed_urls.clear()
        self.client = TestClient(main.app)
        self.client.headers["X-Expected-User"] = "user-id"  # the page names the user it was opened for
        session = EneoSsoSession(
            access_token="module-user-token",
            expires_at=int(time.time()) + 60,
            refresh_at=int(time.time()) + 30,
            session_expires_at=int(time.time()) + 3600,
            module_key="speech-to-text",
            tenant_id="tenant-id",
            user=ModuleUser(id="user-id", email="user@example.test"),
        )
        main.module_auth.sessions.clear()
        self.client.cookies.set(SESSION_COOKIE, main.module_auth.sessions.create(session))

    def tearDown(self) -> None:
        main.http_client = self.original_client
        main._signed_urls.clear()


class AudioProxyTests(AudioProxyCase):
    def test_rebase_signed_url_keeps_path_and_token(self) -> None:
        self.assertEqual(
            main._rebase_signed_url(SIGNED, "http://eneo-backend:8000"),
            "http://eneo-backend:8000/api/v1/files/file-1/download/?token=abc",
        )

    def test_audio_is_streamed_with_range_and_module_credentials(self) -> None:
        response = self.client.get(
            "/api/eneo/flows/flow-1/runs/run-1/input-files/file-1/audio",
            headers={"Range": "bytes=0-3"},
        )

        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.content, b"abcd")
        self.assertEqual(response.headers["content-range"], "bytes 0-3/10")
        self.assertEqual(response.headers["accept-ranges"], "bytes")
        self.assertNotIn("set-cookie", response.headers)

        # Signed URL minted upstream with the module's credentials, inline.
        self.assertEqual(len(self.fake.signed_url_calls), 1)
        call = self.fake.signed_url_calls[0]
        self.assertEqual(
            call["url"],
            "https://eneo.example.test/api/v1/flows/flow-1/runs/run-1/input-files/file-1/signed-url/",
        )
        self.assertEqual(call["json"]["content_disposition"], "inline")
        headers = call["headers"]
        self.assertEqual(headers["X-API-Key"], "test-key")
        self.assertEqual(headers["Authorization"], "Bearer module-user-token")

        # The stream fetch kept the signed path and token and forwarded Range.
        stream_request = self.fake.stream_requests[0]
        self.assertEqual(
            str(stream_request.url),
            "https://eneo.example.test/api/v1/files/file-1/download/?token=abc",
        )
        self.assertEqual(stream_request.headers["range"], "bytes=0-3")

    def test_signed_url_is_reused_across_range_requests(self) -> None:
        for _ in range(3):
            self.client.get(
                "/api/eneo/flows/flow-1/runs/run-1/input-files/file-1/audio",
                headers={"Range": "bytes=0-3"},
            )
        self.assertEqual(len(self.fake.signed_url_calls), 1)
        self.assertEqual(len(self.fake.stream_requests), 3)

    def test_audio_route_rejects_dot_segments(self) -> None:
        response = self.client.get(
            "/api/eneo/flows/flow-1/runs/%2E%2E/input-files/file-1/audio",
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.fake.signed_url_calls, [])

    def test_an_eneo_that_cannot_be_reached_for_the_signed_url_is_the_same_502_as_everywhere_else(self) -> None:
        async def unreachable(url, **kwargs):
            raise httpx.ConnectError("connection refused")

        self.fake.post = unreachable

        response = self.client.get("/api/eneo/flows/flow-1/runs/run-1/input-files/file-1/audio")

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"error": "upstream_unreachable", "detail": "Eneo could not be reached."})
        self.assertEqual(self.fake.stream_requests, [])

    def test_the_slash_twin_of_the_audio_route_is_not_a_route(self) -> None:
        response = self.client.get("/api/eneo/flows/flow-1/runs/run-1/input-files/file-1/audio/")

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json(), {"detail": "Eneo resource is not exposed"})
        self.assertEqual(self.fake.signed_url_calls, [])

    def test_audio_route_requires_session(self) -> None:
        anonymous = TestClient(main.app)
        response = anonymous.get(
            "/api/eneo/flows/flow-1/runs/run-1/input-files/file-1/audio",
        )
        self.assertEqual(response.status_code, 401)


class StreamClosureTests(AudioProxyCase):
    """Eneo's answer is closed however the response ends: whole, an upstream error, or the browser going away at any point
    (a task waiting for Eneo's next chunk, a chunk being sent, a send that cannot proceed)."""

    AUDIO = "/api/eneo/flows/flow-1/runs/run-1/input-files/file-1/audio"

    def serve(self, stream: ScriptedStream, browser) -> None:
        """One GET of the audio run as the server runs it, until it ends, however it ends. ``browser(send_body, cancel)``
        returns the ``send`` of the browser's side: ``send_body`` is the event of each body message, ``cancel`` ends the app."""
        self.fake.response = stream

        async def run() -> None:
            async def receive():
                await anyio.sleep_forever()  # the browser says nothing

            scope = {
                "type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"}, "http_version": "1.1", "method": "GET",
                "scheme": "http", "root_path": "", "path": self.AUDIO, "raw_path": self.AUDIO.encode(), "query_string": b"",
                "headers": [
                    (b"host", b"testserver"),
                    (b"cookie", f"{SESSION_COOKIE}={self.client.cookies.get(SESSION_COOKIE)}".encode()),
                    (b"x-expected-user", b"user-id"),
                ],
                "client": ("testclient", 50000), "server": ("testserver", 80),
            }
            async with anyio.create_task_group() as group:
                async def app() -> None:
                    with contextlib.suppress(Exception):  # an upstream error or a browser that left ends the app with one
                        await main.app(scope, receive, browser(group.cancel_scope.cancel))

                group.start_soon(app)

        anyio.run(run)

    def test_a_file_read_to_its_end_is_closed(self) -> None:
        stream = ScriptedStream([b"abc", b"def"])

        self.serve(stream, lambda cancel: lambda message: asyncio.sleep(0))

        self.assertTrue(stream.closed)

    def test_an_upstream_that_breaks_in_the_middle_of_the_body_is_closed(self) -> None:
        stream = ScriptedStream([b"abc"], then="breaks")

        self.serve(stream, lambda cancel: lambda message: asyncio.sleep(0))

        self.assertTrue(stream.closed)

    def test_a_browser_that_goes_away_while_eneos_next_chunk_is_awaited_leaves_nothing_open(self) -> None:
        stream = ScriptedStream([b"abc"], then="stalls")

        def browser(cancel):
            async def send(message) -> None:
                if message["type"] == "http.response.body" and message["body"]:
                    cancel()  # the server cancels the response after the first chunk

            return send

        self.serve(stream, browser)

        self.assertTrue(stream.closed)

    def test_a_browser_that_goes_away_while_a_chunk_is_being_sent_leaves_nothing_open(self) -> None:
        stream = ScriptedStream([b"abc", b"def", b"ghi"])

        def browser(cancel):
            async def send(message) -> None:
                if message["type"] == "http.response.body" and message["body"] == b"def":
                    raise OSError("the connection is gone")  # what the server's send raises for a browser that left

            return send

        self.serve(stream, browser)

        self.assertTrue(stream.closed)

    def test_a_response_cancelled_while_it_waits_to_send_leaves_nothing_open(self) -> None:
        stream = ScriptedStream([b"abc", b"def", b"ghi"])

        def browser(cancel):
            async def send(message) -> None:
                if message["type"] == "http.response.body" and message["body"] == b"def":
                    cancel()
                    await anyio.sleep_forever()  # a client that has stopped reading: the write never completes

            return send

        self.serve(stream, browser)

        self.assertTrue(stream.closed)
