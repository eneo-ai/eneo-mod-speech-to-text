import os
import time
import unittest

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "https://module.example.test")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("AUTH_MODE", "eneo_sso")

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


class FakeAudioClient:
    def __init__(self) -> None:
        self.signed_url_calls: list[dict[str, object]] = []
        self.stream_requests: list[httpx.Request] = []

    async def post(self, url, **kwargs):
        self.signed_url_calls.append({"url": url, **kwargs})
        return FakeSignedUrlResponse()

    def build_request(self, method, url, headers=None):
        return httpx.Request(method, url, headers=headers)

    async def send(self, request, stream=False):
        self.stream_requests.append(request)
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


class AudioProxyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_client = main.http_client
        self.fake = FakeAudioClient()
        main.http_client = self.fake
        main._signed_audio_urls.clear()
        self.client = TestClient(main.app)
        session = EneoSsoSession(
            access_token="module-user-token",
            expires_at=int(time.time()) + 60,
            module_key="speech-to-text",
            tenant_id="tenant-id",
            user=ModuleUser(id="user-id", email="user@example.test"),
        )
        main.module_auth.sessions.clear()
        self.client.cookies.set(SESSION_COOKIE, main.module_auth.sessions.create(session))

    def tearDown(self) -> None:
        main.http_client = self.original_client
        main._signed_audio_urls.clear()

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

    def test_audio_route_requires_session(self) -> None:
        anonymous = TestClient(main.app)
        response = anonymous.get(
            "/api/eneo/flows/flow-1/runs/run-1/input-files/file-1/audio",
        )
        self.assertEqual(response.status_code, 401)
