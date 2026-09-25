import asyncio
import configparser
import contextlib
import json
import os
import re
import shlex
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "https://module.example.test")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("AUTH_MODE", "eneo_sso")

import httpx  # noqa: E402
import uvicorn  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402
from uvicorn.main import main as uvicorn_cli  # noqa: E402
from websockets.asyncio.client import connect as websocket_connect  # noqa: E402
from websockets.asyncio.server import serve  # noqa: E402
from websockets.exceptions import ConnectionClosed  # noqa: E402

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
ERROR = {
    "type": "error",
    "code": "duration_exceeded",
    "message": "The recording is longer than live transcription allows.",
    "retryable": False,
}
DELTA = {"type": "transcript.delta", "text": "hej "}
REPOSITORY = Path(__file__).resolve().parents[2]


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
    """Eneo's live socket on a real port: `ready`, a delta per frame, `done` at stop.

    Other modes: "close_after_ready"; "error_on_first_frame", which sends ERROR
    and closes, as Eneo does when a session ends early; "stop_reading", which
    never reads again but keeps talking, so it notices when the relay drops it;
    "stall_then_read", which reads nothing until `resume` is set, then sends
    DELTA and reads to the end, so the relay's close completes normally.
    """

    def __init__(self) -> None:
        self.mode = "relay"
        # The stop it answers, and its answer.
        self.stop_frame = STOP
        self.done = {"type": "transcript.done", "text": "hej då"}
        self.resume = threading.Event()
        self.close_code: int | None = None
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
            if self.mode == "close_after_ready":
                return
            if self.mode == "stop_reading":
                with contextlib.suppress(ConnectionClosed):
                    while True:
                        await socket.send(json.dumps(DELTA))
                        await asyncio.sleep(0.05)
                return
            if self.mode == "stall_then_read":
                while not self.resume.is_set():
                    await asyncio.sleep(0.01)
                await socket.send(json.dumps(DELTA))
                async for _ in socket:
                    pass
                return
            async for frame in socket:
                self.frames.append(frame)
                if self.mode == "error_on_first_frame":
                    await socket.send(json.dumps(ERROR))
                    return
                if frame == self.stop_frame:
                    await socket.send(json.dumps(self.done))
                    return
                await socket.send(
                    json.dumps({"type": "transcript.delta", "text": f"{len(frame)} bytes "})
                )
        finally:
            self.close_code = socket.close_code
            self.closed.set()

    def drop_connections(self) -> None:
        """Abort every connection, so even a relay stuck writing to Eneo ends."""

        def abort() -> None:
            for connection in self._server.connections:
                connection.transport.abort()

        self._loop.call_soon_threadsafe(abort)

    def stop(self) -> None:
        async def shutdown() -> None:
            self._server.close()
            await self._server.wait_closed()

        asyncio.run_coroutine_threadsafe(shutdown(), self._loop).result(5)
        self._loop.call_soon_threadsafe(self._loop.stop)


class PausableDelivery:
    """ASGI wrapper that holds the relay's messages to the browser while paused."""

    def __init__(self, app) -> None:
        self.app = app
        self.delivering = threading.Event()
        self.delivering.set()

    async def __call__(self, scope, receive, send) -> None:
        async def held_send(message) -> None:
            if message["type"] == "websocket.send":
                while not self.delivering.is_set():
                    await asyncio.sleep(0.01)
            await send(message)

        await self.app(scope, receive, held_send)


class RelayFixture:
    """A fake Eneo that the module backend's settings point at."""

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

    def tearDown(self) -> None:
        main.settings.eneo_backend_url = self.original_backend_url
        main.http_client = self.original_client
        main.module_auth.http_client = self.original_auth_client
        self.eneo_socket.stop()

    def create_session(self, *, refresh_at: int) -> str:
        now = int(time.time())
        return main.module_auth.sessions.create(
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


class LiveRelayTests(RelayFixture, unittest.TestCase):
    def setUp(self) -> None:
        super().setUp()
        self.delivery = PausableDelivery(main.app)
        self.client = TestClient(self.delivery)
        self.sign_in(refresh_at=int(time.time()) + 30)

    def sign_in(self, *, refresh_at: int) -> None:
        self.client.cookies.set(SESSION_COOKIE, self.create_session(refresh_at=refresh_at))

    def connect(self, origin: str | None = MODULE_ORIGIN, query: str = ""):
        headers = {} if origin is None else {"Origin": origin}
        return self.client.websocket_connect(LIVE_PATH + query, headers=headers)

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

    def test_the_recording_id_goes_with_the_ticket_request_only_when_valid(self) -> None:
        recording_id = "3f2b8c1e-5d4a-4f6b-9c7d-2e1a0b9c8d7e"
        queries = {
            f"?recording_id={recording_id}": {"recording_id": recording_id},
            "": None,
            "?recording_id=short12": None,
            f"?recording_id={'a' * 65}": None,
            "?recording_id=not%2Fplain-1234": None,
            # A trailing newline, which a pattern ending in `$` would let through.
            "?recording_id=abcdefgh%0A": None,
        }
        for query, body in queries.items():
            with self.subTest(query=query):
                with self.connect(query=query) as browser:
                    self.assertEqual(browser.receive_json(), READY)
                # Without a valid id, Eneo is asked for a preview: no body at all.
                self.assertEqual(self.eneo_api.calls[-1].get("json"), body)

    def test_the_stop_count_and_the_transcript_id_pass_unchanged(self) -> None:
        stop = '{"type":"stop","produced_samples":3200}'
        done = {"type": "transcript.done", "text": "hej då", "transcript_id": "t-1"}
        self.eneo_socket.stop_frame, self.eneo_socket.done = stop, done

        with self.connect() as browser:
            browser.receive_json()
            browser.send_text(stop)
            self.assertEqual(browser.receive_json(), done)
            self.assert_closed(browser)

        self.assertEqual(self.eneo_socket.frames, [stop])

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
        self.eneo_socket.mode = "close_after_ready"

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

    def test_eneo_error_reaches_a_slow_browser_before_the_close(self) -> None:
        self.eneo_socket.mode = "error_on_first_frame"

        with self.connect() as browser:
            self.assertEqual(browser.receive_json(), READY)
            self.delivery.delivering.clear()
            try:
                browser.send_bytes(b"\x00\x00")
                self.assertTrue(self.eneo_socket.closed.wait(5))
                # Audio keeps coming, so the relay finds Eneo gone while the
                # error is still on its way to the browser.
                browser.send_bytes(b"\x00\x00")
                browser.send_bytes(b"\x00\x00")
                time.sleep(0.3)
            finally:
                self.delivery.delivering.set()
            self.assertEqual(browser.receive_json(), ERROR)
            self.assert_closed(browser)

    def test_eneo_that_stops_reading_ends_the_session_in_bounded_time(self) -> None:
        self.eneo_socket.mode = "stop_reading"
        frame = os.urandom(64 * 1024)  # zeros would compress to nothing on the wire

        with (
            patch.object(main, "_LIVE_SEND_TIMEOUT_SECONDS", 0.5),
            patch.object(main, "_LIVE_CLOSE_TIMEOUT_SECONDS", 0.5),
            self.connect() as browser,
        ):
            try:
                self.assertEqual(browser.receive_json(), READY)
                for _ in range(512):  # 32 MiB, more than every buffer on the way
                    browser.send_bytes(frame)
                self.assertTrue(
                    self.eneo_socket.closed.wait(10), "Eneo's socket stayed open"
                )
                with self.assertRaises(WebSocketDisconnect) as ended:
                    while True:  # Eneo's deltas, then the close
                        self.assertEqual(browser.receive_json(), DELTA)
                self.assertEqual(ended.exception.code, 1011)
            finally:
                self.eneo_socket.drop_connections()

    def test_timed_out_write_to_eneo_ends_with_1011_after_a_clean_close(self) -> None:
        self.eneo_socket.mode = "stall_then_read"
        frame = os.urandom(64 * 1024)  # zeros would compress to nothing on the wire
        gave_up = threading.Event()
        close_eneo_socket = main._close_eneo_socket

        async def closing(eneo) -> None:
            gave_up.set()
            await close_eneo_socket(eneo)

        with (
            patch.object(main, "_LIVE_SEND_TIMEOUT_SECONDS", 0.5),
            patch.object(main, "_LIVE_CLOSE_TIMEOUT_SECONDS", 10),
            patch.object(main, "_close_eneo_socket", closing),
            self.connect() as browser,
        ):
            try:
                self.assertEqual(browser.receive_json(), READY)
                for _ in range(512):  # 32 MiB, more than every buffer on the way
                    browser.send_bytes(frame)
                self.assertTrue(gave_up.wait(10), "the relay never gave up on Eneo")
            finally:
                # Eneo reads again, so the relay's close completes with 1000.
                self.eneo_socket.resume.set()
            self.assertEqual(browser.receive_json(), DELTA)
            self.assert_closed(browser, 1011)
        self.assertTrue(self.eneo_socket.closed.wait(5))
        self.assertEqual(self.eneo_socket.close_code, 1000)

    def test_browser_that_stops_reading_ends_the_session_in_bounded_time(self) -> None:
        with (
            patch.object(main, "_LIVE_SEND_TIMEOUT_SECONDS", 0.5),
            self.connect() as browser,
        ):
            self.assertEqual(browser.receive_json(), READY)
            self.delivery.delivering.clear()
            try:
                browser.send_bytes(b"\x00\x00")  # Eneo answers; the browser takes nothing
                self.assertTrue(
                    self.eneo_socket.closed.wait(5), "Eneo's socket stayed open"
                )
            finally:
                self.delivery.delivering.set()
            self.assert_closed(browser, 1011)
        self.assertEqual(self.eneo_socket.frames, [b"\x00\x00"])


def uvicorn_options(command: list[str]) -> dict[str, object]:
    """The options uvicorn's own command line makes of a launch command."""
    arguments = command[command.index("app.main:app") :]
    return uvicorn_cli.make_context("uvicorn", arguments).params


def launch_commands() -> dict[str, list[str]]:
    """Every way the repository starts the module backend."""
    supervisord = configparser.ConfigParser(interpolation=None)
    supervisord.read(REPOSITORY / "deploy" / "supervisord.conf")
    dockerfile = (REPOSITORY / "backend" / "Dockerfile").read_text()
    readme = (REPOSITORY / "README.md").read_text()
    return {
        "production image": shlex.split(supervisord["program:backend"]["command"]),
        "backend image": json.loads(re.search(r"^CMD (.+)$", dockerfile, re.M)[1]),
        "README dev server": shlex.split(
            re.search(r"^\.venv/bin/python -m (uvicorn .+)$", readme, re.M)[1]
        ),
    }


@contextlib.contextmanager
def serve_module(**options):
    """The module backend on uvicorn, as the image runs it; yields the port."""
    server = uvicorn.Server(
        uvicorn.Config(
            main.app, host="127.0.0.1", port=0, lifespan="off", log_level="warning", **options
        )
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 5
        while not server.started:
            if time.monotonic() > deadline:
                raise RuntimeError("uvicorn did not start")
            time.sleep(0.01)
        yield server.servers[0].sockets[0].getsockname()[1]
    finally:
        server.should_exit = True
        thread.join(5)


class BrowserTransportLimitTests(RelayFixture, unittest.TestCase):
    def test_every_launch_path_sets_the_same_browser_limits(self) -> None:
        limits = {
            name: {
                option: uvicorn_options(command)[option]
                for option in ("ws_max_size", "ws_max_queue")
            }
            for name, command in launch_commands().items()
        }

        for name, limit in limits.items():
            with self.subTest(name):
                self.assertEqual(limit, limits["production image"])

    def test_production_limits_refuse_an_oversized_message_before_eneo(self) -> None:
        options = uvicorn_options(launch_commands()["production image"])
        max_size, max_queue = options["ws_max_size"], options["ws_max_queue"]
        # Eneo's largest audio frame fits, and a connection queues at most 2 MiB.
        self.assertGreaterEqual(max_size, 64 * 1024)
        self.assertLessEqual(max_size * max_queue, 2 * 2**20)
        session_id = self.create_session(refresh_at=int(time.time()) + 30)

        async def stream(port: int) -> int:
            async with websocket_connect(
                f"ws://127.0.0.1:{port}{LIVE_PATH}",
                origin=MODULE_ORIGIN,
                additional_headers={"Cookie": f"{SESSION_COOKIE}={session_id}"},
            ) as browser:
                self.assertEqual(json.loads(await browser.recv()), READY)
                await browser.send(bytes(64 * 1024))
                await browser.recv()  # Eneo took the frame
                # Incompressible, so uvicorn refuses it on the frame header.
                await browser.send(os.urandom(max_size + 1))
                with self.assertRaises(ConnectionClosed) as refused:
                    await asyncio.wait_for(browser.recv(), 5)
                return refused.exception.rcvd.code

        with serve_module(ws_max_size=max_size, ws_max_queue=max_queue) as port:
            self.assertEqual(asyncio.run(stream(port)), 1009)
        self.assertEqual([len(frame) for frame in self.eneo_socket.frames], [64 * 1024])


if __name__ == "__main__":
    unittest.main()
