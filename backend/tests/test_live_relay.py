import asyncio
import json
import os
import threading
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
from starlette.websockets import WebSocketDisconnect  # noqa: E402
from websockets.asyncio.server import serve  # noqa: E402

from app import main  # noqa: E402
from app.module_auth import EneoSsoSession, ModuleUser, SESSION_COOKIE  # noqa: E402
from test_module_auth import token_payload  # noqa: E402

FLOW_ID = "0b6f1c9e-3d2a-4c55-9a51-7f0e2b1d4c10"
STEP_ID = "5e2d8a41-9c07-4b3f-8e6a-1d2c3b4a5f60"
LIVE_PATH = f"/api/live/{FLOW_ID}/{STEP_ID}"
MODULE_ORIGIN = "https://module.example.test"
TICKET = "ticket-1"
STOP = '{"type":"stop"}'
READY = {"type": "ready", "sample_rate": 16000, "max_seconds": 18000}


def ticket_response(ticket: str = TICKET) -> httpx.Response:
    """Eneo's 201 from the live-transcription-sessions route."""
    return httpx.Response(
        201,
        json={
            "ticket": ticket,
            "websocket_path": "/api/v1/live-transcription",
            "subprotocol": "eneo-live.v1",
            "expires_at": "2026-09-23T10:15:30Z",
            "sample_rate": 16000,
            "max_seconds": 18000,
            "model": {"id": "7d0c7a8e-8b4c-4c1e-9d3e-2f4b6a1c9e10", "name": "Pianissimo"},
        },
    )


class FakeEneoApi:
    """Eneo's ticket route and token refresh, answering as httpx would."""

    def __init__(self) -> None:
        self.ticket = ticket_response()
        self.calls: list[dict[str, object]] = []

    async def post(self, url: str, **kwargs):
        self.calls.append({"url": url, **kwargs})
        if url.endswith("/token/refresh/"):
            return httpx.Response(200, json=token_payload("refreshed-token"))
        if isinstance(self.ticket, Exception):
            raise self.ticket
        return self.ticket


class FakeEneoSocket:
    """Eneo's live socket on a real port: `ready`, a delta per frame, `done` at stop."""

    def __init__(self) -> None:
        self.close_after_ready = False
        self.handshakes = []
        self.frames: list[bytes | str] = []
        self.closed = threading.Event()
        self._loop = asyncio.new_event_loop()
        listening = threading.Event()
        threading.Thread(target=self._serve, args=(listening,), daemon=True).start()
        listening.wait(5)

    def _serve(self, listening: threading.Event) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._listen())
        listening.set()
        self._loop.run_forever()

    async def _listen(self) -> None:
        self._server = await serve(
            self._session,
            "127.0.0.1",
            0,
            subprotocols=["eneo-live.v1"],
            process_request=self._admit,
        )
        self.port = self._server.sockets[0].getsockname()[1]

    def _admit(self, connection, request):
        self.handshakes.append(request)
        if f"ticket.{TICKET}" not in request.headers.get("Sec-WebSocket-Protocol", ""):
            # Eneo closes an unknown ticket before accepting: HTTP 403.
            return connection.respond(403, "Forbidden\n")
        return None

    async def _session(self, socket) -> None:
        try:
            await socket.send(json.dumps(READY))
            if self.close_after_ready:
                return
            async for frame in socket:
                self.frames.append(frame)
                if frame == STOP:
                    await socket.send(json.dumps({"type": "transcript.done", "text": "hej då"}))
                    return
                await socket.send(
                    json.dumps({"type": "transcript.delta", "text": f"{len(frame)} bytes "})
                )
        finally:
            self.closed.set()

    def stop(self) -> None:
        async def shutdown() -> None:
            self._server.close()
            await self._server.wait_closed()

        asyncio.run_coroutine_threadsafe(shutdown(), self._loop).result(5)
        self._loop.call_soon_threadsafe(self._loop.stop)


class LiveRelayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.eneo_socket = FakeEneoSocket()
        self.eneo_api = FakeEneoApi()
        self.original_client = main.http_client
        self.original_auth_client = main.module_auth.http_client
        self.original_backend_url = main.settings.eneo_backend_url
        self.eneo_url = f"http://127.0.0.1:{self.eneo_socket.port}"
        main.settings.eneo_backend_url = self.eneo_url
        main.http_client = self.eneo_api
        main.module_auth.http_client = self.eneo_api
        main.module_auth.sessions.clear()
        self.client = TestClient(main.app)
        self.sign_in(refresh_at=int(time.time()) + 30)

    def tearDown(self) -> None:
        main.settings.eneo_backend_url = self.original_backend_url
        main.http_client = self.original_client
        main.module_auth.http_client = self.original_auth_client
        self.eneo_socket.stop()

    def sign_in(self, *, refresh_at: int) -> None:
        now = int(time.time())
        session_id = main.module_auth.sessions.create(
            EneoSsoSession(
                access_token="module-user-token",
                expires_at=now + 60,
                refresh_at=refresh_at,
                session_expires_at=now + 3600,
                module_key="speech-to-text",
                tenant_id="tenant-id",
                user=ModuleUser(id="user-id", email="user@example.test"),
            )
        )
        self.client.cookies.set(SESSION_COOKIE, session_id)

    def connect(self, origin: str | None = MODULE_ORIGIN):
        headers = {} if origin is None else {"Origin": origin}
        return self.client.websocket_connect(LIVE_PATH, headers=headers)

    def assert_closed(self, browser, code: int = 1000) -> None:
        with self.assertRaises(WebSocketDisconnect) as ended:
            browser.receive_json()
        self.assertEqual(ended.exception.code, code)

    def test_signed_in_user_streams_to_eneo_and_reads_its_events_in_order(self) -> None:
        with self.connect() as browser:
            self.assertEqual(browser.receive_json(), READY)
            browser.send_bytes(b"\x01\x00" * 160)
            self.assertEqual(
                browser.receive_json(), {"type": "transcript.delta", "text": "320 bytes "}
            )
            browser.send_bytes(b"\x02\x00" * 80)
            self.assertEqual(
                browser.receive_json(), {"type": "transcript.delta", "text": "160 bytes "}
            )
            browser.send_text(STOP)
            self.assertEqual(
                browser.receive_json(), {"type": "transcript.done", "text": "hej då"}
            )
            self.assert_closed(browser)

        # The ticket was asked for with the user's module credentials...
        (ticket_call,) = self.eneo_api.calls
        self.assertEqual(
            ticket_call["url"],
            f"{self.eneo_url}/api/v1/flows/{FLOW_ID}/steps/{STEP_ID}"
            "/live-transcription-sessions/",
        )
        self.assertEqual(
            ticket_call["headers"],
            {"X-API-Key": "test-key", "Authorization": "Bearer module-user-token"},
        )
        # ...and redeemed server-side, without the browser's Origin.
        (handshake,) = self.eneo_socket.handshakes
        self.assertEqual(handshake.path, "/api/v1/live-transcription")
        self.assertEqual(
            handshake.headers["Sec-WebSocket-Protocol"], f"eneo-live.v1, ticket.{TICKET}"
        )
        self.assertNotIn("Origin", handshake.headers)

    def test_frames_reach_eneo_unchanged(self) -> None:
        frames: list[bytes | str] = [
            b"\x00\x00",
            bytes(range(256)) * 256,  # 64 KiB
            b"\x01",  # odd length: Eneo, not the relay, judges frames
            "not json",
            STOP,
        ]
        with self.connect() as browser:
            browser.receive_json()
            for frame in frames:
                if isinstance(frame, bytes):
                    browser.send_bytes(frame)
                else:
                    browser.send_text(frame)
                browser.receive_json()
            self.assert_closed(browser)

        # Compared whole: unittest's diff of a 64 KiB frame takes minutes.
        self.assertTrue(self.eneo_socket.frames == frames, "Eneo got other frames")

    def test_anonymous_handshake_is_refused(self) -> None:
        self.client.cookies.clear()

        with self.assertRaises(WebSocketDisconnect) as refused:
            with self.connect():
                pass

        self.assertEqual(refused.exception.code, 1008)
        self.assertEqual(self.eneo_api.calls, [])
        self.assertEqual(self.eneo_socket.handshakes, [])

    def test_cross_origin_handshake_is_refused(self) -> None:
        for origin in ("https://attacker.example.test", None):
            with self.subTest(origin=origin):
                with self.assertRaises(WebSocketDisconnect) as refused:
                    with self.connect(origin):
                        pass

                self.assertEqual(refused.exception.code, 1008)
        self.assertEqual(self.eneo_api.calls, [])
        self.assertEqual(self.eneo_socket.handshakes, [])

    def test_refused_ticket_arrives_as_one_error_event(self) -> None:
        self.eneo_api.ticket = httpx.Response(
            409,
            json={
                "message": "Live transcription is not available for this flow.",
                "eneo_error_code": 40900,
                "code": "flow_live_transcription_unavailable",
                "context": {"reason": "model_not_realtime"},
                "request_id": "request-1",
            },
        )

        with self.connect() as browser:
            self.assertEqual(
                browser.receive_json(),
                {
                    "type": "error",
                    "code": "flow_live_transcription_unavailable",
                    "message": "Live transcription is not available for this flow.",
                    "retryable": False,
                },
            )
            self.assert_closed(browser)
        self.assertEqual(self.eneo_socket.handshakes, [])

    def test_unreachable_eneo_arrives_as_one_retryable_error_event(self) -> None:
        failures = {
            "ticket route unreachable": httpx.ConnectError("unreachable"),
            "socket refuses the ticket": ticket_response("expired-ticket"),
        }
        for failure, ticket in failures.items():
            with self.subTest(failure):
                self.eneo_api.ticket = ticket

                with self.connect() as browser:
                    self.assertEqual(
                        browser.receive_json(),
                        {
                            "type": "error",
                            "code": "upstream_unreachable",
                            "message": "Eneo could not be reached.",
                            "retryable": True,
                        },
                    )
                    self.assert_closed(browser)

    def test_browser_leaving_closes_eneo_socket(self) -> None:
        with self.connect() as browser:
            browser.receive_json()
            browser.send_bytes(b"\x00\x00")
            browser.receive_json()  # Eneo has the frame

        self.assertTrue(self.eneo_socket.closed.wait(5))
        self.assertEqual(self.eneo_socket.frames, [b"\x00\x00"])

    def test_eneo_closing_closes_browser_socket(self) -> None:
        self.eneo_socket.close_after_ready = True

        with self.connect() as browser:
            self.assertEqual(browser.receive_json(), READY)
            self.assert_closed(browser)

    def test_due_token_is_refreshed_before_the_ticket_is_requested(self) -> None:
        self.sign_in(refresh_at=int(time.time()) - 1)

        with self.connect() as browser:
            self.assertEqual(browser.receive_json(), READY)

        refresh, ticket = self.eneo_api.calls
        self.assertTrue(refresh["url"].endswith("/module-auth/speech-to-text/token/refresh/"))
        self.assertEqual(ticket["headers"]["Authorization"], "Bearer refreshed-token")


if __name__ == "__main__":
    unittest.main()
