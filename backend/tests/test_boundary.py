"""What crosses the module's two boundaries: the browser's request into Eneo, and Eneo's answer back.

Both ends are real: the module's app runs under uvicorn on a free loopback port (so the path it sees is decoded once,
as in production), and Eneo is a second uvicorn server that records the request line it receives and the headers it is
sent. The module's own shared ``main.http_client`` talks to it over a real socket; nothing on its side is stubbed.
"""

import asyncio
import gzip
import http.client
import json
import os
import re
import socket
import threading
import time
import unittest
from dataclasses import dataclass
from datetime import datetime, timezone
from unittest.mock import patch
from urllib.parse import parse_qs, urljoin, urlparse

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "https://module.example.test")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("AUTH_MODE", "eneo_sso")

import uvicorn  # noqa: E402
import httpx  # noqa: E402
import websockets.asyncio.client  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from app import main  # noqa: E402
from app.config import load_settings  # noqa: E402
from app.module_auth import SESSION_COOKIE, EneoSsoSession, ModuleUser  # noqa: E402

ORIGIN = main.settings.module_origin
FAR_FUTURE = 4102444800  # 2100-01-01
MiB = 1 << 20
CAP = 4 * MiB  # max_response_bytes in the tests of how much of an answer is read


@dataclass
class Seen:
    """One request as Eneo received it: ``raw_path`` as sent, ``path`` as Eneo's server decodes it (once)."""

    method: str
    raw_path: str
    path: str
    headers: dict[str, str]
    body: bytes
    header_list: list[tuple[str, str]]  # every header as sent, so a repeated one can be seen


class FakeEneo:
    """A real server. ``respond(seen)`` returns (status, [(header, value)], body); the default is an empty JSON object."""

    def __init__(self, respond=None) -> None:
        self.respond = respond or (lambda seen: (200, [("content-type", "application/json")], b"{}"))
        self.requests: list[Seen] = []
        self.sent = 0  # bytes of lazily served answers handed to the server
        self.outcomes: list[str] = []  # one per lazily served answer: "complete", or "dropped" if the client hung up first
        self.active = 0  # lazily served answers still being served

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            return
        body = b""
        while True:
            message = await receive()
            body += message.get("body", b"")
            if not message.get("more_body"):
                break
        seen = Seen(
            method=scope["method"],
            raw_path=scope["raw_path"].decode(),
            path=scope["path"],
            headers={name.decode().lower(): value.decode("latin-1") for name, value in scope["headers"]},
            body=body,
            header_list=[(name.decode().lower(), value.decode("latin-1")) for name, value in scope["headers"]],
        )
        self.requests.append(seen)
        status, headers, payload = self.respond(seen)
        # One connection per request: the module's shared client lives on whichever loop a test runs.
        framing = [(b"connection", b"close")]
        lazy = not isinstance(payload, bytes)
        if not lazy:
            framing.append((b"content-length", str(len(payload)).encode()))
        await send({"type": "http.response.start", "status": status, "headers": [(k.encode(), v.encode("latin-1")) for k, v in headers] + framing})
        if not lazy:
            await send({"type": "http.response.body", "body": payload})
            return
        hung_up = asyncio.ensure_future(receive())  # resolves with http.disconnect when the client closes
        outcome = "complete"
        self.active += 1
        try:
            async for chunk in payload():
                if hung_up.done():
                    outcome = "dropped"
                    return
                self.sent += len(chunk)
                await send({"type": "http.response.body", "body": chunk, "more_body": True})
                await asyncio.sleep(0)
            await send({"type": "http.response.body", "body": b""})
        except Exception:  # the server refuses a write to a connection that has gone
            outcome = "dropped"
        finally:
            hung_up.cancel()
            self.outcomes.append(outcome)
            self.active -= 1

    @property
    def url(self) -> str:
        return self.served.url


class Served:
    """An ASGI app under uvicorn on a free loopback port, in a thread with its own event loop."""

    def __init__(self, app) -> None:
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        self.url = f"http://127.0.0.1:{listener.getsockname()[1]}"
        self.server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
        self.thread = threading.Thread(target=lambda: asyncio.run(self.server.serve(sockets=[listener])), daemon=True)

    def __enter__(self) -> "Served":
        self.thread.start()
        while not self.server.started:
            time.sleep(0.01)
        return self

    def __exit__(self, *exc) -> None:
        self.server.should_exit = True
        self.thread.join(10)


def a_session(access_token: str) -> str:
    now = int(time.time())
    return main.module_auth.sessions.create(
        EneoSsoSession(
            access_token=access_token,
            expires_at=now + 600,
            refresh_at=now + 300,
            session_expires_at=now + 3600,
            module_key="speech-to-text",
            tenant_id="tenant-id",
            user=ModuleUser(id=f"user-{access_token}", email=f"{access_token}@example.test"),
        )
    )


ENEO: FakeEneo
ENEO_SERVER: Served
MODULE_SERVER: Served


def setUpModule() -> None:
    global ENEO, ENEO_SERVER, MODULE_SERVER
    ENEO = FakeEneo()
    ENEO_SERVER = Served(ENEO).__enter__()
    ENEO.served = ENEO_SERVER
    MODULE_SERVER = Served(main.app).__enter__()


def tearDownModule() -> None:
    MODULE_SERVER.__exit__()
    ENEO_SERVER.__exit__()


class BoundaryCase(unittest.TestCase):
    def setUp(self) -> None:
        self.eneo = ENEO
        self.eneo.requests.clear()
        self.eneo.sent, self.eneo.outcomes = 0, []
        self.eneo.respond = lambda seen: (200, [("content-type", "application/json")], b"{}")
        self.addCleanup(self.wait_until_eneo_is_idle)
        self.addCleanup(setattr, main.settings, "eneo_backend_url", main.settings.eneo_backend_url)
        main.settings.eneo_backend_url = self.eneo.url
        main.module_auth.sessions.clear()
        main._signed_urls.clear()
        self.addCleanup(main._signed_urls.clear)
        self.session_a = a_session("token-of-a")
        self.session_b = a_session("token-of-b")

    def respond_with(self, respond) -> None:
        self.eneo.respond = respond

    def wait_until_eneo_is_idle(self) -> None:
        """Eneo notices a hang-up a moment after the module has answered; no answer may outlive its test."""
        deadline = time.time() + 10
        while self.eneo.active and time.time() < deadline:
            time.sleep(0.02)

    @staticmethod
    def browser() -> httpx.Client:
        """A browser: a cookie jar of its own, and no redirect followed."""
        return httpx.Client(base_url=MODULE_SERVER.url, follow_redirects=False, trust_env=False, timeout=30)

    def request(self, method: str, path: str, session: str | None = None, **kwargs):
        """One request from a browser that has sent nothing before, so no cookie is carried over from another call."""
        headers = {"Origin": ORIGIN, **kwargs.pop("headers", {})}
        if session is not None:
            headers["Cookie"] = f"{SESSION_COOKIE}={session}"
        with self.browser() as client:
            return client.request(method, path, headers=headers, **kwargs)


class DoubleEncodingTests(BoundaryCase):
    """F1: one decode by this module, a second by Eneo. What Eneo decodes must still be the route the module allowed."""

    def assert_eneo_sees(self, response, route: str) -> None:
        """Either nothing reached Eneo and the module refused, or what Eneo decodes is one route of its API."""
        api = [seen for seen in self.eneo.requests if seen.path.startswith("/api/")]  # not the file a signed URL names
        if not api:
            self.assertEqual(response.status_code, 403)
            return
        for seen in api:
            self.assertRegex(seen.path, rf"^{route}$", f"sent as {seen.raw_path}, decoded by Eneo to {seen.path}")

    def test_an_encoded_slash_in_a_proxied_path_is_not_a_path_boundary_for_eneo(self) -> None:
        cases = {
            "GET": ("/api/eneo/flows/a%252Fexport/published/", r"/api/v1/flows/[^/]+/published/"),
            "POST": ("/api/eneo/flows/a%252Fexport/runs/", r"/api/v1/flows/[^/]+/runs/"),
        }
        for method, (path, route) in cases.items():
            with self.subTest(method):
                self.eneo.requests.clear()

                response = self.request(method, path, self.session_a, **({"content": b"{}"} if method == "POST" else {}))

                self.assert_eneo_sees(response, route)

    def test_an_encoded_slash_in_an_upload_path_is_not_a_path_boundary_for_eneo(self) -> None:
        routes = {
            "/api/eneo/flows/a%252Fexport/files/": r"/api/v1/flows/[^/]+/files/",
            "/api/eneo/flows/a%252Fx/steps/s/runtime-files/": r"/api/v1/flows/[^/]+/steps/[^/]+/runtime-files/",
            "/api/eneo/flows/f/steps/a%252Fx/runtime-files/": r"/api/v1/flows/[^/]+/steps/[^/]+/runtime-files/",
            "/api/eneo/flows/a%252Fexport/template-files/": r"/api/v1/flows/[^/]+/template-files/",
        }
        for path, route in routes.items():
            with self.subTest(path):
                self.eneo.requests.clear()

                response = self.request("POST", path, self.session_a, files={"upload_file": ("a.webm", b"audio", "audio/webm")})

                self.assert_eneo_sees(response, route)

    def test_an_encoded_slash_in_a_signed_url_mint_path_is_not_a_path_boundary_for_eneo(self) -> None:
        def mint(seen: Seen):
            if seen.path.endswith("/signed-url/"):
                return 200, [("content-type", "application/json")], json.dumps({"url": f"{self.eneo.url}/files/x?sig=1", "expires_at": FAR_FUTURE}).encode()
            return 200, [("content-type", "audio/webm")], b"audio"

        self.respond_with(mint)
        routes = {
            "/api/eneo/flows/a%252Fx/runs/r/input-files/f/audio": r"/api/v1/flows/[^/]+/runs/[^/]+/input-files/[^/]+/signed-url/",
            "/api/eneo/flows/f/runs/a%252Fx/input-files/f/audio": r"/api/v1/flows/[^/]+/runs/[^/]+/input-files/[^/]+/signed-url/",
            "/api/eneo/flows/f/runs/r/input-files/a%252Fx/audio": r"/api/v1/flows/[^/]+/runs/[^/]+/input-files/[^/]+/signed-url/",
            "/api/eneo/flows/f/runs/r/artifacts/a%252Fx/content": r"/api/v1/flows/[^/]+/runs/[^/]+/artifacts/[^/]+/signed-url/",
        }
        for path, route in routes.items():
            with self.subTest(path):
                self.eneo.requests.clear()
                main._signed_urls.clear()

                response = self.request("GET", path, self.session_a)

                self.assert_eneo_sees(response, route)


class UnsafePathTests(BoundaryCase):
    """What cannot be one segment of an Eneo path is refused by the module, never sent and never a 500."""

    PATHS = {
        "a control character in a proxied path": ("GET", "/api/eneo/flows/a%0Ab/published/"),
        "NUL in a proxied path": ("GET", "/api/eneo/flows/a%00b/published/"),
        "a backslash in a proxied path": ("GET", "/api/eneo/flows/a%5Cb/published/"),
        "a control character in an upload path": ("POST", "/api/eneo/flows/a%0Ab/files/"),
        "a control character in a mint path": ("GET", "/api/eneo/flows/f/runs/r/input-files/a%0Ab/audio"),
    }

    def test_a_control_character_or_backslash_in_a_path_is_refused(self) -> None:
        for label, (method, path) in self.PATHS.items():
            with self.subTest(label):
                self.eneo.requests.clear()
                files = {"files": {"upload_file": ("a.webm", b"audio", "audio/webm")}} if method == "POST" else {}

                response = self.request(method, path, self.session_a, **files)

                # 404, not 403, where the router itself cannot match a line break in a path.
                self.assertIn(response.status_code, (403, 404))
                self.assertEqual(self.eneo.requests, [])

    def test_a_path_too_long_for_a_url_is_refused_by_the_module_not_sent(self) -> None:
        with self.assertRaises(HTTPException) as refused:
            main._upstream_url("flows/" + "a" * 70_000 + "/")

        self.assertEqual(refused.exception.status_code, 414)

    def test_a_long_path_reaches_the_module_as_a_4xx_never_a_500(self) -> None:
        # Raw, because httpx itself refuses to send a URL over 65,536 characters (InvalidURL: it would be a 500 here).
        host, port = urlparse(MODULE_SERVER.url).netloc.split(":")
        connection = http.client.HTTPConnection(host, int(port), timeout=30)
        connection.request("GET", "/api/eneo/flows/" + "a" * 70_000 + "/published/", headers={"Cookie": f"{SESSION_COOKIE}={self.session_a}"})
        status = connection.getresponse().status
        connection.close()

        self.assertTrue(400 <= status < 500, status)
        self.assertEqual(self.eneo.requests, [])


class BrowserHeaderTests(BoundaryCase):
    """The browser's headers are the browser's: one httpx cannot encode is a 400, and framing is the module's own."""

    def raw(self, method: str, path: str, headers: dict[str, str], body=None, **kwargs) -> tuple[int, bytes]:
        """A request as a client that sends bytes httpx would not: http.client writes a header value as latin-1."""
        host, port = urlparse(MODULE_SERVER.url).netloc.split(":")
        connection = http.client.HTTPConnection(host, int(port), timeout=30)
        connection.request(method, path, body=body, headers={"Cookie": f"{SESSION_COOKIE}={self.session_a}", "Origin": ORIGIN, **headers}, **kwargs)
        response = connection.getresponse()
        answer = (response.status, response.read())
        connection.close()
        return answer

    def test_a_header_value_httpx_cannot_encode_is_a_400_not_a_500(self) -> None:
        cases = {
            "the proxy, Accept-Language": ("GET", "/api/eneo/flows/", {"Accept-Language": "sv-caf\u00e9"}),
            "the proxy, Idempotency-Key": ("GET", "/api/eneo/flows/", {"Idempotency-Key": "caf\u00e9"}),
            "the signed file's Accept": ("GET", "/api/eneo/flows/f/runs/r/input-files/x/audio", {"Accept": "audio/\u00e9"}),
            "the signed file's Range": ("GET", "/api/eneo/flows/f/runs/r/input-files/x/audio", {"Range": "bytes=0-\u00e9"}),
        }
        self.respond_with(lambda seen: (200, [("content-type", "application/json")], json.dumps({"url": f"{self.eneo.url}/files/x?sig=1", "expires_at": FAR_FUTURE}).encode()))
        for label, (method, path, headers) in cases.items():
            with self.subTest(label):
                self.eneo.requests.clear()

                status, _ = self.raw(method, path, headers)

                self.assertEqual(status, 400)
                self.assertEqual(self.eneo.requests, [])

    def test_a_header_that_is_not_forwarded_is_not_checked_for_encoding(self) -> None:
        status, _ = self.raw("GET", "/api/eneo/flows/", {"X-Note": "caf\u00e9"})

        self.assertEqual(status, 200)
        self.assertNotIn("x-note", self.eneo.requests[-1].headers)

    def test_a_chunked_post_is_forwarded_whole_without_its_framing_headers(self) -> None:
        payload = b'{"input": "text"}'
        host, port = urlparse(MODULE_SERVER.url).netloc.split(":")
        with socket.create_connection((host, int(port)), timeout=30) as connection:
            connection.sendall(
                (
                    f"POST /api/eneo/flows/f/runs/ HTTP/1.1\r\nHost: module\r\nOrigin: {ORIGIN}\r\n"
                    f"Cookie: {SESSION_COOKIE}={self.session_a}\r\nContent-Type: application/json\r\n"
                    f"Transfer-Encoding: chunked\r\n\r\n{len(payload[:5]):x}\r\n".encode()
                    + payload[:5] + f"\r\n{len(payload[5:]):x}\r\n".encode() + payload[5:] + b"\r\n0\r\n\r\n"
                )
            )
            answer = connection.recv(65536)

        self.assertTrue(answer.startswith(b"HTTP/1.1 200"), answer)
        seen = self.eneo.requests[-1]
        self.assertEqual(seen.body, payload)
        self.assertNotIn("transfer-encoding", seen.headers)

    LISTED = {
        "Accept": "application/json",
        "Accept-Language": "sv-SE",
        "Content-Type": "application/json",
        "Idempotency-Key": "flow-run:1",
        "If-Match": '"v1"',
        "If-None-Match": '"v2"',
    }
    UNLISTED = {
        "Forwarded": "for=6.6.6.6",
        "X-Forwarded-For": "6.6.6.6",
        "X-Forwarded-Host": "evil.example",
        "X-Forwarded-Proto": "http",
        "X-Real-IP": "6.6.6.6",
        "Via": "1.1 evil",
        "X-Request-Id": "abc",
        "X-Custom": "1",
        "X-Space-Id": "someone-elses-space",
        "X-Upload-Timeout-Seconds": "900",
        "Accept-Charset": "utf-8",
        "Range": "bytes=0-1",
        "TE": "trailers",
        "Upgrade": "h2c",
        "Keep-Alive": "timeout=5",
        "Trailer": "X-Late",
        "Proxy-Authorization": "Basic Zm9vOmJhcg==",
        "Authorization": "Bearer browser-controlled-token",
        "X-API-Key": "browser-controlled-key",
        "Referer": "https://module.example.test/flows",
    }

    def test_only_the_listed_request_headers_reach_eneo(self) -> None:
        # Deny by default: a header a browser, a proxy or a script adds is not Eneo's to receive.
        status, _ = self.raw("GET", "/api/eneo/flows/", {**self.LISTED, **self.UNLISTED, "User-Agent": "browser/1.0"})

        self.assertEqual(status, 200)
        received = self.eneo.requests[-1].headers
        for name, value in self.LISTED.items():
            self.assertEqual(received.get(name.lower()), value, name)
        for name in self.UNLISTED:
            self.assertNotEqual(received.get(name.lower()), self.UNLISTED[name], name)
        self.assertEqual(received["authorization"], "Bearer token-of-a")
        self.assertEqual(received["x-api-key"], "test-key")
        self.assertNotIn("browser/1.0", received.get("user-agent", ""))
        self.assertEqual(
            set(received) - {"host", "accept-encoding", "connection", "user-agent", "content-length"},
            {name.lower() for name in self.LISTED} | {"authorization", "x-api-key"},
        )

    def test_the_signed_file_request_carries_range_if_range_and_accept_and_nothing_else(self) -> None:
        self.respond_with(
            lambda seen: (200, [("content-type", "application/json")], json.dumps({"url": f"{self.eneo.url}/files/x?sig=1", "expires_at": FAR_FUTURE}).encode())
            if seen.path.endswith("/signed-url/")
            else (206, [("content-type", "audio/webm")], b"au")
        )

        status, _ = self.raw(
            "GET", "/api/eneo/flows/f/runs/r/input-files/x/audio",
            {**self.UNLISTED, "Range": "bytes=0-1", "If-Range": '"v1"', "Accept": "audio/webm"},
        )

        self.assertEqual(status, 206)
        file_request = next(seen for seen in self.eneo.requests if seen.path == "/files/x")
        self.assertEqual((file_request.headers["range"], file_request.headers["if-range"], file_request.headers["accept"]), ("bytes=0-1", '"v1"', "audio/webm"))
        for name in self.UNLISTED:
            if name != "Range":
                self.assertNotEqual(file_request.headers.get(name.lower()), self.UNLISTED[name], name)

    def test_a_header_named_like_the_key_header_is_the_modules_never_the_browsers(self) -> None:
        self.addCleanup(setattr, main.settings, "eneo_api_key_header_name", main.settings.eneo_api_key_header_name)
        main.settings.eneo_api_key_header_name = "Idempotency-Key"

        status, _ = self.raw("GET", "/api/eneo/flows/", {"Idempotency-Key": "browser-chosen"})

        self.assertEqual(status, 200)
        self.assertEqual([value for name, value in self.eneo.requests[-1].header_list if name == "idempotency-key"], ["test-key"])


class RawEneo:
    """Eneo's HTTP and its WebSocket handshake by hand, so a test chooses every byte of the handshake answer.

    The ticket request (a POST) is answered with ``ticket``; anything else is a WebSocket handshake, answered with
    ``handshake(request_line, headers)``. ``handshakes`` are the handshakes it was asked for.
    """

    def __init__(self, ticket: bytes, handshake) -> None:
        self.ticket, self.handshake, self.handshakes = ticket, handshake, []

    async def __call__(self, reader, writer) -> None:
        head = (await reader.readuntil(b"\r\n\r\n")).decode("latin-1")
        request_line, *lines = head.split("\r\n")
        headers = {name.lower(): value for name, _, value in (line.partition(": ") for line in lines if line)}
        if int(headers.get("content-length", 0)):
            await reader.readexactly(int(headers["content-length"]))
        if request_line.startswith("POST"):
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: %d\r\n\r\n%s" % (len(self.ticket), self.ticket))
        else:
            self.handshakes.append((request_line, headers))
            writer.write(self.handshake(request_line, headers))
        await writer.drain()
        writer.close()


class Listener:
    """A TCP server that counts who connects and keeps what they send (it answers nothing)."""

    def __init__(self) -> None:
        self.connections, self.received = 0, b""

    async def __call__(self, reader, writer) -> None:
        self.connections += 1
        try:
            self.received += await asyncio.wait_for(reader.read(65536), 2)
        except TimeoutError:
            pass
        writer.close()


class LiveSocketTests(BoundaryCase):
    """The live relay opens Eneo's socket with the user's ticket in its subprotocols: only where Eneo said, and only if it is well formed."""

    FLOW = STEP = "00000000-0000-4000-8000-000000000001"

    def run_session(self, ticket: dict | bytes, handshake) -> tuple[dict, RawEneo, Listener]:
        """A browser opens the relay; returns the first event it gets, the Eneo that was asked, and a second server."""
        body = ticket if isinstance(ticket, bytes) else json.dumps(ticket).encode()

        async def session():
            second = Listener()
            second_server = await asyncio.start_server(second, "127.0.0.1", 0)
            second_port = second_server.sockets[0].getsockname()[1]
            eneo = RawEneo(body, lambda line, headers: handshake(second_port, line, headers))
            eneo_server = await asyncio.start_server(eneo, "127.0.0.1", 0)
            self.addCleanup(setattr, main.settings, "eneo_backend_url", main.settings.eneo_backend_url)
            main.settings.eneo_backend_url = f"http://127.0.0.1:{eneo_server.sockets[0].getsockname()[1]}"
            try:
                async with websockets.asyncio.client.connect(
                    MODULE_SERVER.url.replace("http", "ws") + f"/api/live/{self.FLOW}/{self.STEP}",
                    additional_headers={"Cookie": f"{SESSION_COOKIE}={self.session_a}", "Origin": ORIGIN},
                    open_timeout=10,
                ) as browser:
                    first = json.loads(await asyncio.wait_for(browser.recv(), 10))
                await asyncio.sleep(0.3)  # long enough for a second connection, were one going to be made
                return first, eneo, second
            finally:
                for server in (eneo_server, second_server):
                    server.close()
                    await server.wait_closed()

        return asyncio.run(session())

    @staticmethod
    def redirect(status: int = 307):
        return lambda second_port, line, headers: (
            f"HTTP/1.1 {status} Redirect\r\nLocation: ws://127.0.0.1:{second_port}/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        ).encode()

    @staticmethod
    def refuse(second_port, line, headers) -> bytes:
        return b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"

    def test_a_redirect_from_eneos_socket_is_not_followed_and_the_ticket_goes_nowhere_else(self) -> None:
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                event, eneo, second = self.run_session({"ticket": "secret-ticket", "websocket_path": "/ws/live"}, self.redirect(status))

                self.assertEqual((event["type"], event["code"]), ("error", "upstream_unreachable"))
                self.assertEqual(len(eneo.handshakes), 1)
                self.assertIn("ticket.secret-ticket", eneo.handshakes[0][1]["sec-websocket-protocol"])
                self.assertEqual((second.connections, second.received), (0, b""), "the ticket reached a second server")

    def test_a_ticket_or_path_that_cannot_be_used_is_the_promised_error_event(self) -> None:
        cases = {
            "a comma in the ticket": {"ticket": "a,b", "websocket_path": "/ws/live"},
            "a space in the ticket": {"ticket": "a b", "websocket_path": "/ws/live"},
            "an empty ticket": {"ticket": "", "websocket_path": "/ws/live"},
            "a fragment in the path": {"ticket": "t", "websocket_path": "/ws/live#x"},
            "a space in the path": {"ticket": "t", "websocket_path": "/ws/ live"},
            "a control character in the path": {"ticket": "t", "websocket_path": "/ws/\u0001live"},
            "a path on another host": {"ticket": "t", "websocket_path": "//evil.example/ws"},
            "a path that is not one": {"ticket": "t", "websocket_path": "ws/live"},
            "no JSON": b"<html>bad gateway</html>",
        }
        for label, ticket in cases.items():
            with self.subTest(label):
                event, eneo, second = self.run_session(ticket, self.refuse)

                self.assertEqual((event["type"], event["code"]), ("error", "upstream_unreachable"))
                self.assertEqual(eneo.handshakes, [], "a socket was opened with what Eneo sent")
                self.assertEqual(second.connections, 0)

    def test_a_usable_ticket_still_reaches_eneos_socket(self) -> None:
        event, eneo, _ = self.run_session({"ticket": "ok.ticket-1_~", "websocket_path": "/ws/live?x=1"}, self.refuse)

        self.assertEqual(len(eneo.handshakes), 1)
        self.assertTrue(eneo.handshakes[0][0].startswith("GET /ws/live?x=1 "))
        self.assertIn("ticket.ok.ticket-1_~", eneo.handshakes[0][1]["sec-websocket-protocol"])


class RedirectTests(BoundaryCase):
    """F2: a ``next`` never sends the browser to another host, however the browser reads the Location it gets."""

    HOSTILE = (
        "/\t/review.example",
        "/\r/review.example",
        "/\n/review.example",
        "/\r\n/review.example",
        "/\t\t/review.example",
        "/%09/review.example",
        "/%2F/review.example",
        "/\\review.example",
        "//review.example",
        "/ /review.example",
        "/\x00/review.example",
        "https://review.example",
    )

    def setUp(self) -> None:
        super().setUp()
        self.signed_in_as = "user-id"
        self.respond_with(self.exchange)

    def exchange(self, seen: Seen):
        """Eneo's ticket exchange and session check, for whoever ``self.signed_in_as`` is."""
        user = {"id": self.signed_in_as, "email": "user@example.test"}
        if seen.method == "POST":
            ceiling = datetime.fromtimestamp(time.time() + 4 * 3600, tz=timezone.utc).isoformat()
            body = {
                "access_token": "module-user-token", "token_type": "bearer", "expires_in": 900, "session_expires_at": ceiling,
                "module_key": "speech-to-text", "tenant_id": "tenant-id", "user": user,
            }
        else:
            body = {"module_key": "speech-to-text", "tenant_id": "tenant-id", "user": user}
        return 200, [("content-type", "application/json")], json.dumps(body).encode()

    @staticmethod
    def browser_goes_to(location: str) -> str:
        """The host a browser ends up on: the URL parser removes tab, CR and LF from its input before it reads it."""
        stripped = location.translate({9: None, 10: None, 13: None})
        return urlparse(urljoin(ORIGIN + "/api/auth/callback", stripped)).netloc

    def assert_stays_on_the_module(self, response) -> None:
        self.assertEqual(response.status_code, 303)
        self.assertEqual(self.browser_goes_to(response.headers["location"]), urlparse(ORIGIN).netloc, response.headers["location"])

    def sign_in(self, client, **login) -> object:
        """Login, then the callback Eneo sends the browser back to; returns the callback's response."""
        started = client.get("/api/auth/login", params=login)
        state = parse_qs(urlparse(started.headers["location"]).query)["state"][0]
        return client.get("/api/auth/callback", params={"ticket": "one-time-ticket", "state": state})

    def test_a_login_never_returns_to_another_host(self) -> None:
        for unsafe in self.HOSTILE:
            with self.subTest(next=unsafe):
                self.assert_stays_on_the_module(self.sign_in(self.browser(), next=unsafe))

    def test_a_refused_renewal_never_returns_to_another_host(self) -> None:
        for unsafe in self.HOSTILE:
            with self.subTest(next=unsafe):
                refused = self.browser().get("/api/auth/login", params={"renew": "1", "next": unsafe})

                self.assert_stays_on_the_module(refused)

    def test_a_renewal_by_another_user_never_returns_to_another_host(self) -> None:
        for unsafe in self.HOSTILE:
            with self.subTest(next=unsafe):
                client = self.browser()
                self.signed_in_as = "user-id"
                self.sign_in(client)
                self.signed_in_as = "someone-else"

                self.assert_stays_on_the_module(self.sign_in(client, renew="1", next=unsafe))


class CallbackStateTests(BoundaryCase):
    """A state that is not the one the login handed out ends the login as invalid_state, whatever characters it has."""

    def test_a_state_that_is_not_the_generated_one_never_exchanges_the_ticket(self) -> None:
        for state in ("%C3%A9", "%C3%A9%C3%A9%C3%A9", "%FF%FE", "%00", "%20", "", "x" * 5000, "%E2%82%AC"):
            with self.subTest(state=state[:20]):
                self.eneo.requests.clear()
                with self.browser() as client:
                    client.get("/api/auth/login")  # the pending login's cookie, signed, with the state it holds

                    callback = client.get(f"/api/auth/callback?ticket=one-time&state={state}")

                self.assertEqual(callback.status_code, 303)
                self.assertEqual(callback.headers["location"], "/?auth_error=invalid_state")
                self.assertEqual(self.eneo.requests, [], "the ticket was exchanged")


class CookieJarTests(BoundaryCase):
    """F3: the one shared client is every user's. What Eneo sets for one user is not that user's browser's, nor another's."""

    def test_a_cookie_eneo_sets_for_one_user_is_not_sent_for_another(self) -> None:
        def sticky(seen: Seen):
            return 200, [("content-type", "application/json"), ("set-cookie", "eneo_affinity=secret-of-a; Path=/; HttpOnly")], b"{}"

        self.respond_with(sticky)

        first = self.request("GET", "/api/eneo/flows/", self.session_a)
        second = self.request("GET", "/api/eneo/flows/", self.session_b)

        self.assertEqual((first.status_code, second.status_code), (200, 200))
        self.assertEqual(self.eneo.requests[1].headers["authorization"], "Bearer token-of-b")
        self.assertNotIn("cookie", self.eneo.requests[1].headers, "user B's request carried what Eneo set for user A")

    def test_a_cookie_eneo_sets_does_not_reach_the_browser(self) -> None:
        # Eneo's cookie is not the module's: a name like the module's own session cookie would replace it.
        def cookies(seen: Seen):
            return 200, [("content-type", "application/json"), ("set-cookie", f"{SESSION_COOKIE}=planted; Path=/"), ("set-cookie", "other=1; Path=/")], b"{}"

        self.respond_with(cookies)

        response = self.request("GET", "/api/eneo/flows/", self.session_a)

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("set-cookie", response.headers)


class RedirectFromEneoTests(BoundaryCase):
    """The module follows no redirect and no route of it expects one: a 3xx from Eneo is a 502, and 304 is not a 3xx here."""

    STATUSES = (301, 302, 303, 307, 308)

    def serve(self, redirect_status: int) -> None:
        def respond(seen: Seen):
            if seen.path.endswith("/signed-url/"):
                return 200, [("content-type", "application/json")], json.dumps({"url": f"{self.eneo.url}/files/x?sig=1", "expires_at": FAR_FUTURE}).encode()
            return redirect_status, [("location", "http://backend:8000/elsewhere/")], b""

        self.respond_with(respond)

    def test_a_redirect_is_a_502_for_the_proxy_the_upload_and_the_signed_file(self) -> None:
        calls = {
            "proxy": lambda: self.request("GET", "/api/eneo/flows/", self.session_a),
            "upload": lambda: self.request("POST", "/api/eneo/flows/f/files/", self.session_a, files={"upload_file": ("a.webm", b"audio", "audio/webm")}),
            "signed file": lambda: self.request("GET", "/api/eneo/flows/f/runs/r/input-files/x/audio", self.session_a),
        }
        for status in self.STATUSES:
            for label, call in calls.items():
                with self.subTest(status=status, route=label):
                    self.serve(status)
                    main._signed_urls.clear()

                    response = call()

                    self.assertEqual(response.status_code, 502)
                    self.assertEqual(response.json()["error"], "upstream_redirect")
                    self.assertNotIn("location", response.headers)
                    self.assertEqual(main._signed_urls, {}, "a URL that was redirected is not kept")

    def test_a_not_modified_answer_is_not_a_redirect(self) -> None:
        self.respond_with(lambda seen: (304, [("etag", '"v1"')], b""))

        response = self.request("GET", "/api/eneo/flows/", self.session_a, headers={"If-None-Match": '"v1"'})

        self.assertEqual(response.status_code, 304)


ENDLESS_STOP = 256 * MiB  # an "endless" answer stops here, so that a client that reads it all ends the test and its memory


def lazy(total: int | None, chunk: bytes = b"0" * MiB):
    """A body of ``total`` bytes (endless, up to ENDLESS_STOP, if None) served a MiB at a time, never held."""

    async def body():
        left = ENDLESS_STOP if total is None else total
        while left > 0:
            piece = chunk[:left]
            left -= len(piece)
            yield piece

    return body


class UpstreamAnswerTests(BoundaryCase):
    """How much of an answer from Eneo the module reads: a bound, counted while it arrives, and the answer closed past it."""

    JSON = ("content-type", "application/json")
    # What the server may have taken before it noticed the hang-up: its own and the kernel's buffers, not the answer.
    SLACK = 24 * MiB

    def setUp(self) -> None:
        super().setUp()
        self.addCleanup(setattr, main.settings, "max_response_bytes", main.settings.max_response_bytes)
        main.settings.max_response_bytes = CAP

    def serve(self, status: int, headers: list, body, mint=None) -> None:
        """Eneo answers every call with this; a signed-URL request gets ``mint`` if one is given."""
        good = json.dumps({"url": f"{self.eneo.url}/files/x?sig=1", "expires_at": FAR_FUTURE}).encode()
        self.respond_with(lambda seen: (200, [self.JSON], good) if seen.path.endswith("/signed-url/") and mint is None else (status, headers, body))

    def assert_refused_and_closed(self, response, error: str, limit: int) -> None:
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["error"], error)
        self.wait_until_eneo_is_idle()
        self.assertLessEqual(self.eneo.sent, limit + self.SLACK, "the answer was read on past its bound")
        self.assertEqual(self.eneo.outcomes, ["dropped"], "the answer was not closed")

    def test_an_answer_past_the_bound_is_a_502_that_stops_reading_and_closes_it(self) -> None:
        for label, total in {"a long answer": 300 * MiB, "an endless one": None}.items():
            with self.subTest(label):
                self.eneo.sent, self.eneo.outcomes = 0, []
                self.serve(200, [self.JSON], lazy(total))

                response = self.request("GET", "/api/eneo/flows/", self.session_a)

                self.assert_refused_and_closed(response, "upstream_too_large", CAP)

    def test_a_declared_length_past_the_bound_is_refused_before_a_byte_is_read(self) -> None:
        self.serve(200, [self.JSON, ("content-length", str(10**9))], lazy(300 * MiB))

        response = self.request("GET", "/api/eneo/flows/", self.session_a)

        self.assert_refused_and_closed(response, "upstream_too_large", 0)

    def test_a_compressed_answer_is_refused_whatever_it_would_decode_to(self) -> None:
        bomb = gzip.compress(b"0" * (64 * MiB), 1)  # about 64 KB that decode to 64 MiB
        self.serve(200, [self.JSON, ("content-encoding", "gzip")], bomb)

        response = self.request("GET", "/api/eneo/flows/", self.session_a)

        self.assertEqual((response.status_code, response.json()["error"]), (502, "upstream_too_large"))

    def test_the_module_asks_eneo_for_no_encoding(self) -> None:
        self.request("GET", "/api/eneo/flows/", self.session_a)

        self.assertEqual(self.eneo.requests[-1].headers["accept-encoding"], "identity")

    def test_an_answer_at_the_bound_goes_through(self) -> None:
        self.serve(200, [("content-type", "application/octet-stream")], lazy(CAP))

        response = self.request("GET", "/api/eneo/flows/", self.session_a)

        self.assertEqual((response.status_code, len(response.content)), (200, CAP))

    def test_an_upload_answer_past_the_bound_is_a_502(self) -> None:
        self.serve(200, [self.JSON], lazy(300 * MiB))

        response = self.request("POST", "/api/eneo/flows/f/files/", self.session_a, files={"upload_file": ("a.webm", b"audio", "audio/webm")})

        self.assert_refused_and_closed(response, "upstream_too_large", CAP)

    def test_a_signed_url_answer_past_a_small_bound_is_invalid_and_not_read_on(self) -> None:
        main.settings.max_response_bytes = 64 * MiB
        self.serve(200, [self.JSON], lazy(300 * MiB), mint=False)

        response = self.request("GET", "/api/eneo/flows/f/runs/r/input-files/x/audio", self.session_a)

        self.assert_refused_and_closed(response, "upstream_invalid", MiB)
        self.assertEqual(main._signed_urls, {})

    def test_the_body_of_a_failed_file_answer_is_read_to_a_small_bound_and_closed(self) -> None:
        main.settings.max_response_bytes = 64 * MiB
        self.serve(500, [self.JSON], lazy(300 * MiB))

        response = self.request("GET", "/api/eneo/flows/f/runs/r/input-files/x/audio", self.session_a)

        self.assertEqual(response.status_code, 500)
        self.wait_until_eneo_is_idle()
        self.assertLessEqual(self.eneo.sent, MiB + self.SLACK)
        self.assertEqual(self.eneo.outcomes, ["dropped"])

    def test_a_file_that_streams_is_not_counted(self) -> None:
        self.serve(200, [("content-type", "audio/webm")], lazy(3 * CAP))

        response = self.request("GET", "/api/eneo/flows/f/runs/r/input-files/x/audio", self.session_a)

        self.assertEqual((response.status_code, len(response.content)), (200, 3 * CAP))

    def test_a_ticket_exchange_answer_past_a_small_bound_ends_the_login_without_a_session(self) -> None:
        main.settings.max_response_bytes = 64 * MiB
        self.serve(200, [self.JSON], lazy(300 * MiB))
        with self.browser() as client:
            started = client.get("/api/auth/login")
            state = parse_qs(urlparse(started.headers["location"]).query)["state"][0]

            callback = client.get("/api/auth/callback", params={"ticket": "t", "state": state})

        self.assertEqual(callback.headers["location"], "/?auth_error=exchange_unavailable")
        self.assertNotIn(SESSION_COOKIE, callback.headers.get("set-cookie", ""))
        self.wait_until_eneo_is_idle()
        self.assertLessEqual(self.eneo.sent, MiB + self.SLACK)
        self.assertEqual(self.eneo.outcomes, ["dropped"])


class MintAnswerTests(BoundaryCase):
    """An answer from Eneo to the signed-URL request that the module cannot use is a 502, and nothing of it is kept."""

    AUDIO = "/api/eneo/flows/f/runs/r/input-files/x/audio"

    def answer(self, body: bytes, status: int = 200):
        def mint(seen: Seen):
            if seen.path.endswith("/signed-url/"):
                return status, [("content-type", "application/json"), ("location", "http://backend:8000/elsewhere/")], body
            return 200, [("content-type", "audio/webm")], b"audio"

        self.respond_with(mint)

    def test_a_mint_answer_the_module_cannot_use_is_a_controlled_502_and_is_not_cached(self) -> None:
        url = f"{self.eneo.url}/files/x?sig=1"
        cases = {
            "NUL in the URL path": json.dumps({"url": f"{self.eneo.url}/files/a\u0000b?sig=1", "expires_at": FAR_FUTURE}).encode(),
            "expires_at of 10**400": b'{"url": "' + url.encode() + b'", "expires_at": 1' + b"0" * 400 + b"}",
            "expires_at is Infinity": b'{"url": "' + url.encode() + b'", "expires_at": Infinity}',
            "no url": json.dumps({"expires_at": FAR_FUTURE}).encode(),
            "url is null": json.dumps({"url": None, "expires_at": FAR_FUTURE}).encode(),
            "not JSON": b"<html>bad gateway</html>",
            "a JSON list": b"[]",
            "expires_at is text": json.dumps({"url": url, "expires_at": "soon"}).encode(),
            "expires_at is true": json.dumps({"url": url, "expires_at": True}).encode(),
            "the URL is not http(s)": json.dumps({"url": "ftp://eneo.example.test/files/x", "expires_at": FAR_FUTURE}).encode(),
            "the URL has no host": json.dumps({"url": "/files/x?sig=1", "expires_at": FAR_FUTURE}).encode(),
            "a redirect": b"",
        }
        for label, body in cases.items():
            with self.subTest(label):
                main._signed_urls.clear()
                self.answer(body, status=307 if label == "a redirect" else 200)

                response = self.request("GET", self.AUDIO, self.session_a)

                self.assertEqual(response.status_code, 502)
                self.assertEqual(response.json()["error"], "upstream_invalid")
                self.assertNotIn("location", response.headers)
                self.assertEqual(main._signed_urls, {}, "an answer that was refused must not be kept")

    def test_a_usable_mint_answer_is_streamed_and_kept_for_its_lifetime(self) -> None:
        self.answer(json.dumps({"url": f"{self.eneo.url}/files/x?sig=1", "expires_at": FAR_FUTURE}).encode())

        first = self.request("GET", self.AUDIO, self.session_a)
        second = self.request("GET", self.AUDIO, self.session_a)

        self.assertEqual((first.status_code, first.content, second.status_code), (200, b"audio", 200))
        self.assertEqual(len([seen for seen in self.eneo.requests if seen.path.endswith("/signed-url/")]), 1)
        self.assertEqual(len(main._signed_urls), 1)


class ApiKeyHeaderNameTests(unittest.TestCase):
    """The key travels in a header of its own; the bearer token owns Authorization, and one would replace the other."""

    ENVIRONMENT = {
        "ENEO_BACKEND_URL": "http://backend:8000",
        "ENEO_PUBLIC_URL": "https://eneo.example.test",
        "MODULE_PUBLIC_URL": "https://module.example.test",
        "MODULE_KEY": "speech-to-text",
        "ENEO_API_KEY": "test-key",
        "SESSION_SECRET": "x" * 48,
    }

    def test_the_api_key_header_cannot_be_the_authorization_header(self) -> None:
        for name in ("Authorization", "authorization", "AUTHORIZATION"):
            with self.subTest(name), patch.dict(os.environ, self.ENVIRONMENT | {"ENEO_API_KEY_HEADER_NAME": name}, clear=True):
                with self.assertRaisesRegex(RuntimeError, "ENEO_API_KEY_HEADER_NAME"):
                    load_settings()

    def test_the_api_key_header_cannot_be_a_framing_or_credential_header(self) -> None:
        names = ("Content-Length", "Transfer-Encoding", "Host", "Connection", "Content-Type", "Cookie", "Origin", "Proxy-Authorization", "Upgrade", "TE")
        for name in names:
            with self.subTest(name), patch.dict(os.environ, self.ENVIRONMENT | {"ENEO_API_KEY_HEADER_NAME": name.lower()}, clear=True):
                with self.assertRaisesRegex(RuntimeError, "ENEO_API_KEY_HEADER_NAME"):
                    load_settings()

    def test_an_ordinary_header_name_is_still_accepted(self) -> None:
        for name in ("X-API-Key", "x-eneo-key", "Api-Key"):
            with self.subTest(name), patch.dict(os.environ, self.ENVIRONMENT | {"ENEO_API_KEY_HEADER_NAME": name}, clear=True):
                self.assertEqual(load_settings().eneo_api_key_header_name, name)


if __name__ == "__main__":
    unittest.main()
