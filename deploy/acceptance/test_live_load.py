"""The probe of check 15 against a relay that misbehaves: it must report what it could not measure, never leave it out.

    python -m unittest deploy/acceptance/test_live_load.py      (from the repository root; standard library only)

A fake relay speaks the protocol the stub does (a ``ready`` event, a ``transcript.delta`` for every fourth binary frame) and
can go quiet, send an error event, or close; a fake web server shows the load generator what it does with a server that
never answers.
"""

import asyncio
import base64
import errno
import hashlib
import json
import socket
import struct
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import live_load  # noqa: E402

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def frame(opcode: int, payload: bytes) -> bytes:
    head = bytes([0x80 | opcode])
    if len(payload) < 126:
        return head + bytes([len(payload)]) + payload
    return head + bytes([126]) + struct.pack(">H", len(payload)) + payload


class FakeRelay:
    """A live relay on a port of 127.0.0.1. ``behaviour(reply_number)`` says what to do instead of reply number N: None answers
    it, "quiet" stops answering from then on, "error" sends an error event, "close" closes the socket with 1011."""

    def __init__(self, behaviour=lambda number: None, close_after: float | None = None) -> None:
        self.behaviour = behaviour
        self.close_after = close_after  # seconds of silence from the client after which the relay closes the socket with 1011
        self.server = socket.socket()
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(5)
        self.url = f"http://127.0.0.1:{self.server.getsockname()[1]}"
        self.connections: list[socket.socket] = []
        threading.Thread(target=self._accept, daemon=True).start()

    def close(self) -> None:
        self.server.close()
        for connection in self.connections:
            connection.close()

    def _accept(self) -> None:
        while True:
            try:
                connection, _ = self.server.accept()
            except OSError:
                return
            self.connections.append(connection)
            threading.Thread(target=self._guarded, args=(connection,), daemon=True).start()

    def _guarded(self, connection: socket.socket) -> None:
        try:
            self._serve(connection)
        except OSError:
            pass  # the test is over and closed the socket

    def _serve(self, connection: socket.socket) -> None:
        buffer = b""
        while b"\r\n\r\n" not in buffer:
            data = connection.recv(4096)
            if not data:
                return
            buffer += data
        head, _, buffer = buffer.partition(b"\r\n\r\n")
        key = next(line.split(b":", 1)[1].strip() for line in head.split(b"\r\n") if line.lower().startswith(b"sec-websocket-key"))
        accept = base64.b64encode(hashlib.sha1(key + GUID).digest())
        connection.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
        connection.sendall(frame(1, json.dumps({"type": "ready"}).encode()))
        if self.close_after:
            connection.settimeout(self.close_after)
        frames, replies, quiet = 0, 0, False
        while True:
            while len(buffer) < 2:
                try:
                    data = connection.recv(65536)
                except TimeoutError:
                    connection.sendall(frame(8, struct.pack(">H", 1011)))
                    return
                if not data:
                    return
                buffer += data
            opcode, length, offset = buffer[0] & 0x0F, buffer[1] & 0x7F, 2
            if length == 126:
                (length,), offset = struct.unpack(">H", buffer[2:4]), 4
            offset += 4  # the client's mask
            while len(buffer) < offset + length:
                data = connection.recv(65536)
                if not data:
                    return
                buffer += data
            buffer = buffer[offset + length :]
            if opcode != 2:
                continue
            frames += 1
            if frames % 4 or quiet:
                continue
            replies += 1
            action = self.behaviour(replies)
            if action == "quiet":
                quiet = True
            elif action == "error":
                connection.sendall(frame(1, json.dumps({"type": "error", "code": "upstream_error", "message": "the relay broke"}).encode()))
            elif action == "close":
                connection.sendall(frame(8, struct.pack(">H", 1011)))
                return
            else:
                connection.sendall(frame(1, json.dumps({"type": "transcript.delta", "text": "ord"}).encode()))


def measure(relay: FakeRelay, seconds: float = 1.5, tail_seconds: float = 0.5) -> live_load.Trips:
    return live_load.measure_round_trips(relay.url, "/api/live/f/s", {}, seconds, 20, tail_seconds=tail_seconds)


class RoundTripTests(unittest.TestCase):
    def test_every_reply_that_is_owed_is_measured(self) -> None:
        relay = FakeRelay()
        self.addCleanup(relay.close)

        trips = measure(relay)

        self.assertEqual((trips.expected, trips.received, trips.missing), (7, 7, 0))  # 30 frames, a reply for every fourth
        self.assertEqual(live_load.percentiles(trips)["missing"], 0)

    def test_a_relay_that_goes_quiet_leaves_replies_missing_and_they_are_counted(self) -> None:
        relay = FakeRelay(lambda number: "quiet" if number == 4 else None)  # replies 1 to 3, then nothing, the socket stays open
        self.addCleanup(relay.close)
        began = time.monotonic()

        trips = measure(relay)

        self.assertEqual((trips.expected, trips.received, trips.missing), (7, 3, 4))
        report = live_load.percentiles(trips)
        self.assertEqual((report["expected"], report["received"], report["missing"]), (7, 3, 4))
        self.assertLess(time.monotonic() - began, 1.5 + 0.5 + 2, "the wait for the tail is bounded")
        with self.assertRaises(live_load.Shortfall) as raised:
            live_load.require_complete(("loaded", trips))
        self.assertIn("loaded: 4 of 7 replies never came", str(raised.exception))

    def test_a_tail_that_is_slow_but_arrives_within_the_deadline_is_measured(self) -> None:
        relay = FakeRelay()
        self.addCleanup(relay.close)

        trips = measure(relay, tail_seconds=2)

        self.assertEqual(trips.missing, 0)

    def test_an_error_event_from_the_relay_is_raised_not_ignored(self) -> None:
        relay = FakeRelay(lambda number: "error" if number == 2 else None)
        self.addCleanup(relay.close)

        with self.assertRaises(live_load.RelayError) as raised:
            measure(relay)

        self.assertIn("upstream_error", str(raised.exception))

    def test_a_socket_the_relay_closes_before_the_replies_are_in_is_raised(self) -> None:
        relay = FakeRelay(lambda number: "close" if number == 3 else None)
        self.addCleanup(relay.close)

        with self.assertRaises(live_load.RelayError) as raised:
            measure(relay)

        self.assertIn("1011", str(raised.exception))


class QuietSocketTests(unittest.TestCase):
    def survive(self, relay: FakeRelay, seconds: float = 1.0) -> None:
        live_load.survive_quiet(relay.url, "/api/live/f/s", {}, seconds, reply_seconds=1.5)

    def test_a_socket_that_stays_open_through_the_quiet_relays_four_frames_after_it(self) -> None:
        relay = FakeRelay()
        self.addCleanup(relay.close)

        self.survive(relay)  # no exception

    def test_a_socket_the_relay_closes_during_the_quiet_is_raised_with_how_long_it_lived(self) -> None:
        relay = FakeRelay(close_after=0.4)
        self.addCleanup(relay.close)

        with self.assertRaises(live_load.RelayError) as raised:
            self.survive(relay, seconds=3)

        self.assertIn("1011", str(raised.exception))
        self.assertIn("of 3 s", str(raised.exception))

    def test_a_relay_that_is_open_but_does_not_answer_after_the_quiet_is_raised(self) -> None:
        relay = FakeRelay(lambda number: "quiet")
        self.addCleanup(relay.close)

        with self.assertRaises(live_load.RelayError) as raised:
            self.survive(relay)

        self.assertIn("no reply", str(raised.exception))


class SilentWebServer:
    """Accepts a connection and never answers it."""

    def __init__(self) -> None:
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(50)
        self.url = f"http://127.0.0.1:{self.server.getsockname()[1]}"
        self.connections: list[socket.socket] = []
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self) -> None:
        while True:
            try:
                self.connections.append(self.server.accept()[0])
            except OSError:
                return

    def close(self) -> None:
        self.server.close()
        for connection in self.connections:
            connection.close()


PAGE = (
    b'<link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/assets/a.css"><link rel="modulepreload" href="/assets/m.js">'
    b'<script src="/assets/a.js"></script><a href="/flows">flows</a><link rel="canonical" href="/">'
)


class QuickWebServer(ThreadingHTTPServer):
    daemon_threads = True
    paths: list[str]

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: object) -> None:
            pass

        def do_GET(self) -> None:
            body = PAGE if self.path == "/" else b"x" * 100
            self.server.paths.append(self.path)  # type: ignore[attr-defined]
            self.send_response(self.server.status)  # type: ignore[attr-defined]
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def __init__(self, status: int = 200) -> None:
        super().__init__(("127.0.0.1", 0), self.Handler)
        self.paths = []
        self.status = status
        self.connections = 0
        threading.Thread(target=self.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server_address[1]}"

    def get_request(self):
        connection = super().get_request()
        self.connections += 1
        return connection


class AssetsNamedTests(unittest.TestCase):
    def test_only_what_loading_the_page_fetches_is_named(self) -> None:
        # A headless browser does not ask for the icon (a headed one does, once, and keeps it), and no browser follows an anchor or a canonical link.
        self.assertEqual(live_load.assets_named(PAGE), ["/assets/a.css", "/assets/a.js", "/assets/m.js"])

    def test_a_file_on_another_origin_and_an_inline_script_are_not_the_modules(self) -> None:
        page = b'<script src="//cdn.example/x.js"></script><script src="https://cdn.example/y.js"></script><script>1</script><img src="/brand/logo.svg">'

        self.assertEqual(live_load.assets_named(page), ["/brand/logo.svg"])


class LoadGeneratorTests(unittest.TestCase):
    def test_an_arrival_rate_starts_that_many_visits_a_second_and_replays_the_visit_it_is_given(self) -> None:
        server = QuickWebServer()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        visit = ["/flows/abc", "/assets/one.js", "/assets/two.js", "/api/auth/status"]

        result = asyncio.run(live_load.run_load(server.url, 2, rate=20, visit=visit))

        self.assertAlmostEqual(result["visits"], 40, delta=3)
        self.assertEqual(result["requests"], result["visits"] * len(visit))
        self.assertEqual((result["errors"], result["dropped"]), (0, 0))
        self.assertEqual(server.connections, result["visits"], "arrival-rate visits keep testing fresh connections")

    def test_stress_clients_reuse_connections_across_visits_without_caching_responses(self) -> None:
        server = QuickWebServer()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        result = asyncio.run(live_load.run_load(server.url, 1, clients=2, visit=["/"]))

        self.assertGreater(result["visits"], 4)
        self.assertEqual(result["requests"], result["visits"])
        self.assertEqual(result["errors"], 0)
        self.assertEqual(server.connections, 2, "stress must load the server rather than exhaust the driver's ephemeral ports")

    def test_connection_failures_are_counted_and_identified(self) -> None:
        with patch.object(live_load.asyncio, "open_connection", side_effect=OSError(errno.EADDRNOTAVAIL, "no local port")):
            result = asyncio.run(live_load.run_load("http://127.0.0.1:1", 0.1, clients=1))

        self.assertGreater(result["errors"], 0)
        self.assertEqual(result["requests"], 0)
        self.assertEqual(result["errors_by_cause"], {f"connect:OSError:{errno.EADDRNOTAVAIL}": result["errors"]})

    def test_http_errors_still_fail_the_load_and_identify_the_status(self) -> None:
        server = QuickWebServer(status=503)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        result = asyncio.run(live_load.run_load(server.url, 0.2, clients=1, visit=["/"]))

        self.assertGreater(result["requests"], 0)
        self.assertEqual(result["errors"], result["requests"])
        self.assertEqual(result["errors_by_cause"], {"HTTP:503": result["errors"]})

    def test_without_a_visit_it_fetches_the_page_and_the_assets_it_names(self) -> None:
        server = QuickWebServer()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        result = asyncio.run(live_load.run_load(server.url, 1, clients=2))

        self.assertGreater(result["visits"], 0)
        self.assertEqual(result["requests"], result["visits"] * 4)  # the page, a.css, m.js and a.js: not the icon, not a link
        self.assertEqual(result["errors"], 0)
        self.assertEqual(sorted(set(server.paths)), ["/", "/assets/a.css", "/assets/a.js", "/assets/m.js"])

    def test_a_server_that_never_answers_ends_the_load_in_bounded_time_and_counts_errors(self) -> None:
        server = SilentWebServer()
        self.addCleanup(server.close)
        began = time.monotonic()

        with patch.object(live_load, "REQUEST_DEADLINE", 0.5):
            result = asyncio.run(live_load.run_load(server.url, 1, rate=10, visit=["/"]))

        self.assertLess(time.monotonic() - began, 1 + 0.5 * 2 + 1)
        self.assertGreater(result["errors"], 0)
        self.assertEqual(result["requests"], 0)


if __name__ == "__main__":
    unittest.main()
