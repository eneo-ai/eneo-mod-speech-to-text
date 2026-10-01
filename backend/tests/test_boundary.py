"""What crosses the module's two boundaries: the browser's request into Eneo, and Eneo's answer back.

Both ends are real: the module's app runs under uvicorn on a free loopback port (so the path it sees is decoded once,
as in production), and Eneo is a second uvicorn server that records the request line it receives and the headers it is
sent. The module's own shared ``main.http_client`` talks to it over a real socket; nothing on its side is stubbed.
"""

import asyncio
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
from fastapi import HTTPException  # noqa: E402

from app import main  # noqa: E402
from app.config import load_settings  # noqa: E402
from app.module_auth import SESSION_COOKIE, EneoSsoSession, ModuleUser  # noqa: E402

ORIGIN = main.settings.module_origin
FAR_FUTURE = 4102444800  # 2100-01-01


@dataclass
class Seen:
    """One request as Eneo received it: ``raw_path`` as sent, ``path`` as Eneo's server decodes it (once)."""

    method: str
    raw_path: str
    path: str
    headers: dict[str, str]
    body: bytes


class FakeEneo:
    """A real server. ``respond(seen)`` returns (status, [(header, value)], body); the default is an empty JSON object."""

    def __init__(self, respond=None) -> None:
        self.respond = respond or (lambda seen: (200, [("content-type", "application/json")], b"{}"))
        self.requests: list[Seen] = []

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
        )
        self.requests.append(seen)
        status, headers, payload = self.respond(seen)
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(k.encode(), v.encode("latin-1")) for k, v in headers]
                # One connection per request: the module's shared client lives on whichever loop a test runs.
                + [(b"connection", b"close"), (b"content-length", str(len(payload)).encode())],
            }
        )
        await send({"type": "http.response.body", "body": payload})

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
        self.eneo.respond = lambda seen: (200, [("content-type", "application/json")], b"{}")
        self.addCleanup(setattr, main.settings, "eneo_backend_url", main.settings.eneo_backend_url)
        main.settings.eneo_backend_url = self.eneo.url
        main.module_auth.sessions.clear()
        main._signed_urls.clear()
        self.addCleanup(main._signed_urls.clear)
        self.session_a = a_session("token-of-a")
        self.session_b = a_session("token-of-b")

    def respond_with(self, respond) -> None:
        self.eneo.respond = respond

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

    def test_a_redirect_from_eneo_is_not_handed_to_the_browser(self) -> None:
        # Its Location names Eneo's own host; the module never follows a redirect, and none of its routes expects one.
        def redirect(seen: Seen):
            return 307, [("location", "http://backend:8000/api/v1/flows/")], b""

        self.respond_with(redirect)

        response = self.request("GET", "/api/eneo/flows/", self.session_a)

        self.assertNotIn("location", response.headers)
        self.assertEqual(response.status_code, 502)


class MintAnswerTests(BoundaryCase):
    """An answer from Eneo to the signed-URL request that the module cannot use is a 502, and nothing of it is kept."""

    AUDIO = "/api/eneo/flows/f/runs/r/input-files/x/audio"

    def answer(self, body: bytes):
        def mint(seen: Seen):
            if seen.path.endswith("/signed-url/"):
                return 200, [("content-type", "application/json")], body
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
        }
        for label, body in cases.items():
            with self.subTest(label):
                main._signed_urls.clear()
                self.answer(body)

                response = self.request("GET", self.AUDIO, self.session_a)

                self.assertEqual(response.status_code, 502)
                self.assertEqual(main._signed_urls, {}, "an answer that was refused must not be kept")


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


if __name__ == "__main__":
    unittest.main()
