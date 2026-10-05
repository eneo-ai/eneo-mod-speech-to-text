"""What crosses the module's two boundaries: the browser's request into Eneo, and Eneo's answer back.

Both ends are real: the module's app runs under uvicorn on a free loopback port (so the path it sees is decoded once,
as in production), and Eneo is a second uvicorn server that records the request line it receives and the headers it is
sent. The module's own shared ``main.http_client`` talks to it over a real socket; nothing on its side is stubbed.
"""

import asyncio
import contextlib
import gzip
import http.client
import json
import logging
import os
import socket
import tempfile
import threading
import time
import unittest
from dataclasses import dataclass
from datetime import datetime, timezone
from unittest.mock import patch
from urllib.parse import parse_qs, urljoin, urlparse

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "http://localhost:3002")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")

import uvicorn  # noqa: E402
import httpx  # noqa: E402
import websockets.asyncio.client  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from app import main  # noqa: E402
from app.config import load_settings  # noqa: E402
from app.module_auth import SESSION_COOKIE, EneoSsoSession, ModuleUser  # noqa: E402
from app.upstream import make_client  # noqa: E402

ORIGIN = main.settings.module_origin
FAR_FUTURE = 4102444800  # 2100-01-01
BOUNDARY = "boundaryboundary"
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
        self.websocket = None  # an ASGI websocket app, for a test that needs Eneo's live socket
        self.sent = 0  # bytes of lazily served answers handed to the server
        self.outcomes: list[str] = []  # one per lazily served answer: "complete", or "dropped" if the client hung up first
        self.active = 0  # lazily served answers still being served

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "websocket" and self.websocket is not None:
            await self.websocket(scope, receive, send)
            return
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
        if not lazy and not any(name.lower() == "content-length" for name, _ in headers):
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


def a_session(access_token: str, *, lifetime: int = 600, refresh_in: int = 300, user_id: str | None = None, tenant_id: str = "tenant-id") -> str:
    """A signed-in session; it ends ``lifetime`` seconds from now and is due a refresh ``refresh_in`` seconds from now."""
    now = int(time.time())
    return main.module_auth.sessions.create(
        EneoSsoSession(
            access_token=access_token,
            expires_at=now + lifetime,
            refresh_at=now + refresh_in,
            session_expires_at=now + 3600,
            module_key="speech-to-text",
            tenant_id=tenant_id,
            user=ModuleUser(id=user_id or f"user-{access_token}", email=f"{access_token}@example.test"),
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
        self.eneo.sent, self.eneo.outcomes, self.eneo.websocket = 0, [], None
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

    def user_of(self, session: str) -> str:
        return main.module_auth.sessions.get(session).user.id

    def request(self, method: str, path: str, session: str | None = None, *, names_user: bool = True, **kwargs):
        """One request from a browser that has sent nothing before, so no cookie is carried over from another call.

        The page names the user it was opened for (X-Expected-User), as the frontend does on every /api/eneo request;
        ``names_user=False`` is a page that does not.
        """
        headers = {"Origin": ORIGIN, **kwargs.pop("headers", {})}
        if session is not None:
            headers["Cookie"] = f"{SESSION_COOKIE}={session}"
            if names_user:
                headers.setdefault("X-Expected-User", self.user_of(session))
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
        connection.request(method, path, body=body, headers={"Cookie": f"{SESSION_COOKIE}={self.session_a}", "Origin": ORIGIN, "X-Expected-User": self.user_of(self.session_a), **headers}, **kwargs)
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
                    f"Cookie: {SESSION_COOKIE}={self.session_a}\r\nX-Expected-User: {self.user_of(self.session_a)}\r\nContent-Type: application/json\r\n"
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
        "Referer": "http://localhost:3002/flows",
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
                    MODULE_SERVER.url.replace("http", "ws") + f"/api/live/{self.FLOW}/{self.STEP}?expected_user={self.user_of(self.session_a)}",
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


class AbandonedUploadTests(BoundaryCase):
    """Policy: once the browser's file has been fully received, forwarding it to Eneo finishes, whoever is still there."""

    def test_an_upload_the_browser_walks_away_from_is_still_forwarded_whole_and_its_file_closed(self) -> None:
        payload = os.urandom(3 * MiB)  # more than a spooled file keeps in memory, so it is on disk while it is forwarded
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.addCleanup(setattr, tempfile, "tempdir", tempfile.tempdir)
        tempfile.tempdir = folder.name
        stalled, release, completed = threading.Event(), threading.Event(), []

        def stall(seen: Seen):
            stalled.set()
            release.wait(15)
            return 200, [("content-type", "application/json")], b'{"id": "file-1"}'

        self.respond_with(stall)
        original = main._proxy_multipart_upload

        async def watched(*args, **kwargs):
            response = await original(*args, **kwargs)
            completed.append(response.status_code)
            return response

        with patch.object(main, "_proxy_multipart_upload", watched):
            fds_before = len(os.listdir("/dev/fd"))
            head = f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="upload_file"; filename="a.webm"\r\nContent-Type: audio/webm\r\n\r\n'.encode()
            body = head + payload + f"\r\n--{BOUNDARY}--\r\n".encode()
            host, port = urlparse(MODULE_SERVER.url).netloc.split(":")
            browser = socket.create_connection((host, int(port)))
            browser.sendall(
                (
                    f"POST /api/eneo/flows/f/files/ HTTP/1.1\r\nHost: module\r\nOrigin: {ORIGIN}\r\nCookie: {SESSION_COOKIE}={self.session_a}\r\nX-Expected-User: {self.user_of(self.session_a)}\r\n"
                    f"Content-Type: multipart/form-data; boundary={BOUNDARY}\r\nContent-Length: {len(body)}\r\n\r\n"
                ).encode() + body
            )
            self.assertTrue(stalled.wait(15), "the upload never reached Eneo")
            browser.close()  # the file is whole at the module and Eneo is still working: the browser walks away
            time.sleep(0.3)
            self.assertEqual(completed, [], "forwarding was cut short by the browser leaving")
            release.set()
            deadline = time.time() + 10
            while not completed and time.time() < deadline:
                time.sleep(0.02)
            while len(os.listdir("/dev/fd")) > fds_before and time.time() < deadline:
                time.sleep(0.02)

        self.assertEqual(completed, [200], "forwarding did not finish after the browser left")
        self.assertIn(payload, self.eneo.requests[-1].body, "Eneo did not get the whole file")
        self.assertLessEqual(len(os.listdir("/dev/fd")), fds_before, "the file of the abandoned upload was left open")
        self.assertEqual(os.listdir(folder.name), [])


class UploadDeadlineTests(BoundaryCase):
    """The forward is the finish-after-receipt policy with a limit: a total deadline, not only a timeout per read."""

    def test_an_eneo_that_keeps_making_small_progress_does_not_outlast_the_deadline(self) -> None:
        self.addCleanup(setattr, main.settings, "upload_proxy_timeout_seconds", main.settings.upload_proxy_timeout_seconds)
        main.settings.upload_proxy_timeout_seconds = 1.0  # each read may wait 1 s; the whole forward may take 1 s
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.addCleanup(setattr, tempfile, "tempdir", tempfile.tempdir)
        tempfile.tempdir = folder.name

        async def trickle():
            for _ in range(100):  # a byte every 0.3 s, for 30 s: no single read ever waits a second
                yield b" "
                await asyncio.sleep(0.3)

        self.respond_with(lambda seen: (200, [("content-type", "application/json")], trickle))
        fds_before = len(os.listdir("/dev/fd"))
        started = time.monotonic()

        response = self.request("POST", "/api/eneo/flows/f/files/", self.session_a, files={"upload_file": ("a.webm", os.urandom(3 * MiB), "audio/webm")}, timeout=20)

        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json()["error"], "upstream_upload_timeout")
        self.assertLess(time.monotonic() - started, 8, "the forward outlasted its deadline")
        self.wait_until_eneo_is_idle()
        self.assertEqual(self.eneo.outcomes, ["dropped"], "the connection to Eneo was not closed")
        deadline = time.time() + 5
        while len(os.listdir("/dev/fd")) > fds_before and time.time() < deadline:
            time.sleep(0.02)
        self.assertLessEqual(len(os.listdir("/dev/fd")), fds_before, "the spooled file was left open")
        self.assertEqual(os.listdir(folder.name), [])


class LogCapture(logging.Handler):
    """Every record the app logs, formatted as a log file would show it: with the traceback, and the exception's text."""

    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(logging.Formatter().format(record))

    @property
    def text(self) -> str:
        return "\n".join(self.lines)


class SecretsInLogsTests(BoundaryCase):
    """A response that fails validation holds a token: pydantic quotes its input in the error, so the error is not logged."""

    def capture(self) -> LogCapture:
        capture = LogCapture()
        logging.getLogger().addHandler(capture)
        self.addCleanup(logging.getLogger().removeHandler, capture)
        return capture

    def token_answer(self, access_token: str) -> dict:
        ceiling = datetime.fromtimestamp(time.time() + 4 * 3600, tz=timezone.utc).isoformat()
        return {
            "access_token": access_token, "token_type": "bearer", "expires_in": 900, "session_expires_at": ceiling,
            "module_key": "speech-to-text", "tenant_id": "tenant-id", "user": {"id": "user-id", "email": "user@example.test"},
        }

    def callback(self) -> httpx.Response:
        with self.browser() as client:
            started = client.get("/api/auth/login")
            state = parse_qs(urlparse(started.headers["location"]).query)["state"][0]
            return client.get("/api/auth/callback", params={"ticket": "one-time", "state": state})

    def serve(self, answer: dict, *, path_ends: str) -> None:
        def respond(seen: Seen):
            if seen.path.endswith(path_ends):
                return 200, [("content-type", "application/json")], json.dumps(answer).encode()
            return 200, [("content-type", "application/json")], json.dumps(self.token_answer("valid-token")).encode()

        self.respond_with(respond)

    def test_a_token_exchange_answer_that_fails_validation_is_not_logged(self) -> None:
        logs = self.capture()
        self.serve({"access_token": "SECRET-EXCHANGE-TOKEN", "unexpected": "SECRET-EXCHANGE-EXTRA"}, path_ends="/module-auth/token/")

        callback = self.callback()

        self.assertEqual(callback.headers["location"], "/?auth_error=exchange_invalid")
        self.assertIn("exchange", logs.text.lower(), "the failure itself is still logged")
        self.assertNotIn("SECRET-", logs.text)

    def test_a_session_check_answer_that_fails_validation_is_not_logged(self) -> None:
        logs = self.capture()

        def respond(seen: Seen):
            body = self.token_answer("valid-token") if seen.method == "POST" else {"module_key": "speech-to-text", "leak": "SECRET-CHECK-EXTRA"}
            return 200, [("content-type", "application/json")], json.dumps(body).encode()

        self.respond_with(respond)

        callback = self.callback()

        self.assertEqual(callback.headers["location"], "/?auth_error=validation_invalid")
        self.assertNotIn("SECRET-", logs.text)
        self.assertNotIn("valid-token", logs.text)

    def test_a_refresh_answer_that_fails_validation_is_not_logged(self) -> None:
        logs = self.capture()
        self.serve({"access_token": "SECRET-REFRESH-TOKEN", "unexpected": "SECRET-REFRESH-EXTRA"}, path_ends="/token/refresh/")
        due = a_session("token-due", refresh_in=-5)

        response = self.request("GET", "/api/eneo/flows/", due)

        self.assertEqual(response.status_code, 401)  # Eneo's refresh answer was unusable: the session ends
        self.assertIn("refresh", logs.text.lower(), "the failure itself is still logged")
        self.assertNotIn("SECRET-", logs.text)
        self.assertNotIn("token-due", logs.text)


class EneoLive:
    """Eneo's live socket: accepts, says ``ready``, echoes every audio frame, and records how and when it was closed."""

    def __init__(self) -> None:
        self.closed, self.close_code, self.received = threading.Event(), None, []

    async def __call__(self, scope, receive, send) -> None:
        await receive()
        await send({"type": "websocket.accept", "subprotocol": "eneo-live.v1"})
        await send({"type": "websocket.send", "text": json.dumps({"type": "ready"})})
        while True:
            message = await receive()
            if message["type"] == "websocket.disconnect":
                self.close_code = message.get("code")
                self.closed.set()
                return
            self.received.append(message)
            if message.get("bytes") is not None:
                await send({"type": "websocket.send", "bytes": message["bytes"]})


class LiveCase(BoundaryCase):
    """A browser's live socket through the module to a real Eneo that says ``ready``."""

    FLOW = STEP = "00000000-0000-4000-8000-000000000001"

    def setUp(self) -> None:
        super().setUp()
        self.live = EneoLive()
        self.eneo.websocket = self.live
        self.token_expires_in = 900  # what Eneo says a token it renews lives for

        def respond(seen: Seen):
            ceiling = datetime.fromtimestamp(time.time() + 4 * 3600, tz=timezone.utc).isoformat()
            user = {"id": "user-id", "email": "user@example.test"}
            if seen.path.endswith("/live-transcription-sessions/"):
                body = {"ticket": "tkt", "websocket_path": "/ws/live"}
            elif seen.path.endswith("/token/refresh/") or seen.path.endswith("/module-auth/token/"):
                body = {"access_token": "token-of-" + seen.path.rsplit("/", 2)[-2], "token_type": "bearer", "expires_in": self.token_expires_in, "session_expires_at": ceiling,
                        "module_key": "speech-to-text", "tenant_id": "tenant-id", "user": user}
            elif seen.path.endswith("/session/"):
                body = {"module_key": "speech-to-text", "tenant_id": "tenant-id", "user": user}
            else:
                body = {}
            return 200, [("content-type", "application/json")], json.dumps(body).encode()

        self.respond_with(respond)

    def through(self, session: str, scenario, *, query: str | None = None):
        """A browser opens the relay with ``session`` and waits for ``ready``; ``scenario(browser)`` then runs.

        The page names the user it was opened for, as the frontend does; ``query`` replaces that.
        """
        if query is None:
            query = f"?expected_user={self.user_of(session)}"

        async def run():
            async with websockets.asyncio.client.connect(
                MODULE_SERVER.url.replace("http", "ws") + f"/api/live/{self.FLOW}/{self.STEP}{query}",
                additional_headers={"Cookie": f"{SESSION_COOKIE}={session}", "Origin": ORIGIN},
                open_timeout=10,
            ) as browser:
                self.assertEqual(json.loads(await asyncio.wait_for(browser.recv(), 10))["type"], "ready")
                return await scenario(browser)

        return asyncio.run(run())

    async def assert_ended(self, browser, within: float) -> None:
        """Both sockets are closed within ``within`` seconds, the browser's with a policy close and a fixed reason."""
        await asyncio.wait_for(browser.wait_closed(), within)
        self.assertEqual((browser.close_code, browser.close_reason), (1008, "session_ended"))
        self.assertTrue(await asyncio.to_thread(self.live.closed.wait, within), "Eneo's socket was left open")


class LiveSessionEndTests(LiveCase):
    """An open live socket is the session's: it ends, both sockets closed, when the session does."""

    def test_a_logout_after_ready_closes_both_sockets(self) -> None:
        async def scenario(browser):
            await browser.send(b"\x00" * 64)
            self.assertEqual(await asyncio.wait_for(browser.recv(), 5), b"\x00" * 64)  # the relay works until it ends
            await asyncio.to_thread(self.request, "POST", "/api/auth/logout", self.session_a)
            await self.assert_ended(browser, 5)

        self.through(self.session_a, scenario)

    def test_a_session_that_expires_while_audio_flows_closes_both_sockets(self) -> None:
        session = a_session("token-short", lifetime=2)

        async def scenario(browser):
            async def audio():
                while True:
                    await browser.send(b"\x01" * 64)
                    await asyncio.sleep(0.2)

            sender = asyncio.ensure_future(audio())
            try:
                await self.assert_ended(browser, 6)
            finally:
                sender.cancel()

        self.through(session, scenario)

    def test_an_idle_connection_ends_with_its_session_too(self) -> None:
        session = a_session("token-short", lifetime=2)

        async def scenario(browser):
            await self.assert_ended(browser, 6)  # nothing is sent either way: no frame is there to notice it by

        self.through(session, scenario)

    def test_a_new_login_that_replaces_the_session_closes_the_old_ones_sockets(self) -> None:
        with self.browser() as client:
            def sign_in() -> httpx.Response:
                started = client.get("/api/auth/login")
                state = parse_qs(urlparse(started.headers["location"]).query)["state"][0]
                return client.get("/api/auth/callback", params={"ticket": "one-time", "state": state})

            sign_in()
            first = client.cookies.get(SESSION_COOKIE)

            async def scenario(browser):
                await asyncio.to_thread(sign_in)
                await self.assert_ended(browser, 5)

            self.through(first, scenario)

            self.assertNotEqual(client.cookies.get(SESSION_COOKIE), first)
            self.assertEqual(client.get("/api/auth/status").status_code, 200)
            self.assertEqual(self.request("GET", "/api/eneo/flows/", first, names_user=False).status_code, 401, "the replaced session still lives")

    def test_a_session_that_is_refreshed_after_the_socket_opened_ends_the_socket_at_its_new_expiry(self) -> None:
        # Times are whole seconds in a session, so each step has a margin of a second. Not due when the socket opens
        # (the upgrade does not refresh it); due about 2 s later; its first end is 4 to 5 s from the start.
        session = a_session("token-short", lifetime=5, refresh_in=2, user_id="user-id")  # user-id: whom Eneo's fake renews
        self.token_expires_in = 8  # the renewal gives it 8 s more, from when it happens: a new end 9 to 10 s from the start

        async def scenario(browser):
            started = time.monotonic()
            await asyncio.sleep(2.3)  # the refresh is due now, and the socket is open
            await asyncio.to_thread(self.request, "GET", "/api/auth/status", session)  # the page's polling renews it
            self.assertGreater(main.module_auth.sessions.get(session).expires_at - time.time(), 6, "the renewal did not move the expiry")
            # Past the ORIGINAL end (5 s at the latest), audio still flows.
            await asyncio.sleep(max(0, 5.4 - (time.monotonic() - started)))
            await browser.send(b"\x03" * 8)
            self.assertEqual(await asyncio.wait_for(browser.recv(), 5), b"\x03" * 8)
            # And the socket ends at the REVISED end: not before it, not never.
            await self.assert_ended(browser, 8)
            self.assertGreater(time.monotonic() - started, 8.5, "it ended before the revised expiry")

        self.through(session, scenario)


class ExpectedUserTests(BoundaryCase):
    """An old tab must not send audio under another person's session: a media request names the user its page is for."""

    MEDIA = {
        "an upload": ("POST", "/api/eneo/flows/f/files/", {"files": {"upload_file": ("a.webm", b"audio", "audio/webm")}}),
        "a step's runtime file": ("POST", "/api/eneo/flows/f/steps/s/runtime-files/", {"files": {"upload_file": ("a.webm", b"audio", "audio/webm")}}),
        "a template file": ("POST", "/api/eneo/flows/f/template-files/", {"files": {"upload_file": ("a.webm", b"audio", "audio/webm")}}),
        "the start of a run": ("POST", "/api/eneo/flows/f/runs/", {"content": b'{"input_values": []}'}),
    }

    def test_a_request_for_another_user_is_a_409_and_reaches_nobody(self) -> None:
        for label, (method, path, body) in self.MEDIA.items():
            for header in ({"X-Expected-User": "someone-else"}, {"X-Expected-User": "user-token-of-a", "X-Expected-Tenant": "another-tenant"}):
                with self.subTest(label, header=header):
                    self.eneo.requests.clear()

                    response = self.request(method, path, self.session_a, headers=header, **body)

                    self.assertEqual((response.status_code, response.json()), (409, {"detail": "user_changed"}))
                    self.assertEqual(self.eneo.requests, [])

    def test_a_request_for_the_session_s_user_goes_through(self) -> None:
        for label, (method, path, body) in self.MEDIA.items():
            for header in ({"X-Expected-User": "user-token-of-a"}, {"X-Expected-User": "user-token-of-a", "X-Expected-Tenant": "tenant-id"}):
                with self.subTest(label, header=header):
                    self.eneo.requests.clear()

                    response = self.request(method, path, self.session_a, headers=header, **body)

                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(len(self.eneo.requests), 1)
                    self.assertNotIn("x-expected-user", self.eneo.requests[0].headers, "the page's claim is the module's to check, not Eneo's")

    def test_a_page_that_names_nobody_is_refused_on_every_request_that_changes_something(self) -> None:
        # A tab still running the old page sends no header: after another person signs in, it would send under their cookie.
        changes = {
            **self.MEDIA,
            "a patch": ("PATCH", "/api/eneo/flows/f/runs/r/steps/s/transcript-corrections/", {"content": b"{}"}),
            "a cancel": ("POST", "/api/eneo/flows/f/runs/r/cancel/", {"content": b"{}"}),
        }
        for label, (method, path, body) in changes.items():
            with self.subTest(label):
                self.eneo.requests.clear()

                response = self.request(method, path, self.session_a, names_user=False, **body)

                self.assertEqual((response.status_code, response.json()), (409, {"detail": "user_changed"}))
                self.assertEqual(self.eneo.requests, [], "something was forwarded for a page that named nobody")

    def test_a_read_may_name_nobody_but_a_name_it_gives_must_be_the_sessions(self) -> None:
        # An <audio src> or a plain navigation cannot send a header: reads stay optional.
        for header, status in (({}, 200), ({"X-Expected-User": "user-token-of-a"}, 200), ({"X-Expected-User": "someone-else"}, 409)):
            with self.subTest(header=header):
                self.assertEqual(self.request("GET", "/api/eneo/flows/", self.session_a, names_user=False, headers=header).status_code, status)

    def test_a_page_whose_session_was_replaced_by_another_login_is_refused(self) -> None:
        # The same cookie jar, a different person: tab one's page still names the first user.
        second = a_session("token-of-b")

        refused = self.request("POST", "/api/eneo/flows/f/files/", second, headers={"X-Expected-User": "user-token-of-a"}, files={"upload_file": ("a.webm", b"audio", "audio/webm")})

        self.assertEqual((refused.status_code, refused.json()), (409, {"detail": "user_changed"}))
        self.assertEqual(self.eneo.requests, [])


class LiveExpectedUserTests(LiveCase):
    """The same for the live socket, which a browser cannot give a header: the page's user is a query parameter."""

    def test_a_socket_for_another_user_is_closed_before_a_ticket_is_asked_for(self) -> None:
        async def run():
            async with websockets.asyncio.client.connect(
                MODULE_SERVER.url.replace("http", "ws") + f"/api/live/{self.FLOW}/{self.STEP}?expected_user=someone-else",
                additional_headers={"Cookie": f"{SESSION_COOKIE}={self.session_a}", "Origin": ORIGIN},
                open_timeout=10,
            ) as browser:
                await asyncio.wait_for(browser.wait_closed(), 5)
                return browser.close_code, browser.close_reason

        self.assertEqual(asyncio.run(run()), (1008, "user_changed"))
        self.assertEqual(self.eneo.requests, [], "a ticket was asked for under the wrong user")

    def test_a_socket_for_the_sessions_user_opens(self) -> None:
        async def scenario(browser):
            return None

        for query in ("?expected_user=user-token-of-a", "?expected_user=user-token-of-a&expected_tenant=tenant-id"):
            with self.subTest(query=query):
                self.eneo.requests.clear()

                self.through(self.session_a, scenario, query=query)  # waits for `ready`

                self.assertTrue(any(seen.path.endswith("/live-transcription-sessions/") for seen in self.eneo.requests))

    def test_a_socket_that_names_nobody_is_closed_before_a_ticket_is_asked_for(self) -> None:
        async def run():
            async with websockets.asyncio.client.connect(
                MODULE_SERVER.url.replace("http", "ws") + f"/api/live/{self.FLOW}/{self.STEP}",
                additional_headers={"Cookie": f"{SESSION_COOKIE}={self.session_a}", "Origin": ORIGIN},
                open_timeout=10,
            ) as browser:
                await asyncio.wait_for(browser.wait_closed(), 5)
                return browser.close_code, browser.close_reason

        self.assertEqual(asyncio.run(run()), (1008, "user_changed"))
        self.assertEqual(self.eneo.requests, [], "a ticket was asked for by a page that named nobody")


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

    def test_an_answer_that_cannot_carry_a_body_is_not_judged_by_the_length_it_describes(self) -> None:
        # RFC 9110: a 304 may carry the Content-Length and Content-Encoding of the representation it stands for.
        for label, headers in {
            "a large Content-Length": [("etag", '"v1"'), ("content-length", str(10**9))],
            "a content-encoding": [("etag", '"v1"'), ("content-encoding", "gzip")],
            "both": [("etag", '"v1"'), ("content-length", str(10**9)), ("content-encoding", "gzip")],
        }.items():
            with self.subTest(label):
                self.respond_with(lambda seen, headers=headers: (304, headers, b""))

                response = self.request("GET", "/api/eneo/flows/", self.session_a, headers={"If-None-Match": '"v1"'})

                self.assertEqual(response.status_code, 304)
                self.assertEqual(response.content, b"")

    def test_the_answer_to_a_head_request_is_not_judged_by_the_length_it_describes(self) -> None:
        self.respond_with(lambda seen: (200, [("content-length", str(10**9)), ("content-encoding", "gzip")], b""))

        async def head():
            client = make_client(main.settings)
            try:
                return await client.head(f"{self.eneo.url}/anything")
            finally:
                await client.aclose()

        response = asyncio.run(head())

        self.assertEqual(response.status_code, 200)

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

    def test_a_failed_file_answer_whose_body_breaks_off_is_the_upstream_failure_response(self) -> None:
        async def broken():
            yield b"x" * 10  # fewer bytes than it declares: the server drops the connection

        self.respond_with(
            lambda seen: (200, [self.JSON], json.dumps({"url": f"{self.eneo.url}/files/x?sig=1", "expires_at": FAR_FUTURE}).encode())
            if seen.path.endswith("/signed-url/")
            else (500, [self.JSON, ("content-length", "1000")], broken)
        )

        response = self.request("GET", "/api/eneo/flows/f/runs/r/input-files/x/audio", self.session_a)

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["error"], "upstream_unreachable")
        self.assertEqual(main._signed_urls, {}, "a URL that failed is not kept")

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


class SignedFileHeadersTests(BoundaryCase):
    """A run's input file is whatever the user gave a flow, and it is served from the module's origin: only a type that
    cannot run script opens inline there, the rest is an attachment, and the browser is told not to guess."""

    AUDIO = "/api/eneo/flows/f/runs/r/input-files/x/audio"

    def serve_file(self, headers: list[tuple[str, str]], status: int = 200, body: bytes = b"0123456789") -> None:
        mint = json.dumps({"url": f"{self.eneo.url}/files/x?sig=1", "expires_at": FAR_FUTURE}).encode()
        self.respond_with(
            lambda seen: (200, [("content-type", "application/json")], mint) if seen.path.endswith("/signed-url/") else (status, headers, body)
        )

    def test_a_type_that_could_run_script_is_an_attachment_with_the_name_eneo_gave_it(self) -> None:
        for media_type in ("text/html", "text/html; charset=utf-8", "TEXT/HTML", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/javascript", "application/octet-stream", "text/plain"):
            with self.subTest(media_type):
                self.serve_file([("content-type", media_type), ("content-disposition", 'inline; filename="x.html"')])

                response = self.request("GET", self.AUDIO, self.session_a)

                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["content-disposition"], 'attachment; filename="x.html"')
                self.assertEqual(response.headers["x-content-type-options"], "nosniff")

    def test_a_file_with_no_type_is_an_attachment_too(self) -> None:
        for headers in ([], [("content-disposition", "inline")]):
            with self.subTest(headers):
                self.serve_file(headers)

                response = self.request("GET", self.AUDIO, self.session_a)

                self.assertEqual(response.headers["content-disposition"], "attachment")
                self.assertEqual(response.headers["x-content-type-options"], "nosniff")

    def test_audio_stays_inline_with_its_range_intact(self) -> None:
        for media_type in ("audio/webm", "audio/mpeg", "Audio/WebM; codecs=opus", "video/mp4", "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"):
            with self.subTest(media_type):
                self.serve_file(
                    [("content-type", media_type), ("content-disposition", 'inline; filename="m.bin"'), ("content-range", "bytes 0-1/10"), ("accept-ranges", "bytes"), ("etag", '"v1"')],
                    status=206, body=b"01",
                )

                response = self.request("GET", self.AUDIO, self.session_a, headers={"Range": "bytes=0-1"})

                self.assertEqual((response.status_code, response.content), (206, b"01"))
                self.assertEqual(self.eneo.requests[-1].headers["range"], "bytes=0-1")
                self.assertEqual(response.headers["content-disposition"], 'inline; filename="m.bin"')
                self.assertEqual((response.headers["content-range"], response.headers["accept-ranges"], response.headers["etag"]), ("bytes 0-1/10", "bytes", '"v1"'))
                self.assertEqual(response.headers["x-content-type-options"], "nosniff")
                self.assertEqual(response.headers["cache-control"], "private, no-store")


class SignedFilePoolTests(BoundaryCase):
    """The module's pool has a seat for the next file after one that broke off or that the browser left: a connection
    that was not given back shows as a request that waits for a seat (the pool here has one) until it is refused."""

    AUDIO = "/api/eneo/flows/f/runs/r/input-files/x/audio"

    def setUp(self) -> None:
        super().setUp()
        one_seat = httpx.AsyncClient(
            limits=httpx.Limits(max_connections=1),
            timeout=httpx.Timeout(30.0, pool=3.0),
            headers={"Accept-Encoding": "identity"},
            follow_redirects=False,
            event_hooks=main.http_client.event_hooks,
        )
        self.addCleanup(setattr, main, "http_client", main.http_client)
        main.http_client = one_seat
        self.file = lazy(None)
        mint = json.dumps({"url": f"{self.eneo.url}/files/x?sig=1", "expires_at": FAR_FUTURE}).encode()
        self.respond_with(
            lambda seen: (200, [("content-type", "application/json")], mint)
            if seen.path.endswith("/signed-url/")
            else (200, [("content-type", "audio/webm")], self.file)
        )

    def next_file_is_served(self) -> None:
        self.file = lambda: lazy(10, b"0123456789")()
        response = self.request("GET", self.AUDIO, self.session_a)

        self.assertEqual((response.status_code, response.content), (200, b"0123456789"))

    def test_the_seat_comes_back_when_eneos_answer_breaks_in_the_middle_of_the_body(self) -> None:
        async def breaks():
            yield b"0" * MiB
            raise RuntimeError("Eneo's server fails after its first MiB")

        self.file = breaks
        with contextlib.suppress(httpx.HTTPError):  # the answer ends short, and the browser is told by a broken response
            self.request("GET", self.AUDIO, self.session_a)

        self.next_file_is_served()

    def test_the_seat_comes_back_when_the_browser_leaves_in_the_middle_of_the_file(self) -> None:
        with self.browser() as client:
            with client.stream("GET", self.AUDIO, headers={"Cookie": f"{SESSION_COOKIE}={self.session_a}"}) as response:
                self.assertEqual(response.status_code, 200)
                next(response.iter_raw())  # the first bytes, and then the browser is gone

        self.next_file_is_served()


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
            "expires_at is false": json.dumps({"url": url, "expires_at": False}).encode(),
            "expires_at is an empty string": json.dumps({"url": url, "expires_at": ""}).encode(),
            "expires_at is an empty list": json.dumps({"url": url, "expires_at": []}).encode(),
            "expires_at is an empty object": json.dumps({"url": url, "expires_at": {}}).encode(),
            "expires_at is numeric text": json.dumps({"url": url, "expires_at": "4102444800"}).encode(),
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

    def test_a_mint_answer_without_an_expiry_gets_the_default_one(self) -> None:
        for label, answer in {"missing": {}, "null": {"expires_at": None}}.items():
            with self.subTest(label):
                main._signed_urls.clear()
                self.answer(json.dumps({"url": f"{self.eneo.url}/files/x?sig=1", **answer}).encode())

                response = self.request("GET", self.AUDIO, self.session_a)

                self.assertEqual(response.status_code, 200)
                (kept,) = main._signed_urls.values()
                self.assertAlmostEqual(kept.expires_at, time.time() + main._SIGNED_URL_TTL_SECONDS, delta=30)

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
        "MODULE_PUBLIC_URL": "http://localhost:3002",
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
