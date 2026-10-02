"""What the backend answers as a web server: the security headers on every response, /health, and (B1.3, B1.4) the built UI.

The header set is ``app/security_headers.json``, the one definition; a header an endpoint sets itself wins.
"""

import json
import os
import time
import unittest
from pathlib import Path

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "https://module.example.test")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("AUTH_MODE", "eneo_sso")

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main, web  # noqa: E402
from app.config import LogoFile  # noqa: E402
from app.module_auth import SESSION_COOKIE, EneoSsoSession, ModuleUser  # noqa: E402
from test_boundary import FAR_FUTURE, FakeEneo, MiB, Served, a_session, lazy  # noqa: E402

ORIGIN = main.settings.module_origin
HEADERS_FILE = Path(web.__file__).with_name("security_headers.json")
SANDBOX = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
SIGNED = "https://eneo.example.test/api/v1/files/file-1/download/?token=abc"


def default_headers() -> dict[str, str]:
    """The one definition, read from its file, not from the module that applies it."""
    return json.loads(HEADERS_FILE.read_text())


class FakeStream:
    def __init__(self, headers: dict[str, str], body: bytes) -> None:
        self.status_code = 200
        self.headers = httpx.Headers(headers)
        self._body = body

    async def aiter_raw(self):
        yield self._body

    async def aclose(self) -> None:
        pass


class FakeEneoClient:
    """The module's client, in process: a signed-URL answer and a file with the headers a test chooses."""

    def __init__(self, headers: dict[str, str] | None = None, body: bytes = b"0123456789") -> None:
        self.file_headers = headers or {"content-type": "audio/webm"}
        self.body = body

    async def post(self, url, **kwargs):
        class Minted:
            status_code = 200
            headers = httpx.Headers({"content-type": "application/json"})

            def json(self):
                return {"url": SIGNED, "expires_at": int(time.time()) + 900}

        return Minted()

    def build_request(self, method, url, headers=None, extensions=None):
        return httpx.Request(method, url, headers=headers, extensions=extensions)

    async def send(self, request, stream=False):
        return FakeStream(self.file_headers, self.body)


class HeadersCase(unittest.TestCase):
    def setUp(self) -> None:
        main.module_auth.sessions.clear()
        main._signed_urls.clear()
        self.addCleanup(main._signed_urls.clear)
        session = main.module_auth.sessions.create(
            EneoSsoSession(
                access_token="module-user-token",
                expires_at=int(time.time()) + 600,
                refresh_at=int(time.time()) + 300,
                session_expires_at=int(time.time()) + 3600,
                module_key="speech-to-text",
                tenant_id="tenant-id",
                user=ModuleUser(id="user-id", email="user@example.test"),
            )
        )
        self.client = TestClient(main.app, raise_server_exceptions=False, follow_redirects=False)
        self.client.cookies.set(SESSION_COOKIE, session)
        self.client.headers["X-Expected-User"] = "user-id"
        self.anonymous = TestClient(main.app, raise_server_exceptions=False, follow_redirects=False)

    def serve_files(self, **kwargs) -> FakeEneoClient:
        fake = FakeEneoClient(**kwargs)
        self.addCleanup(setattr, main, "http_client", main.http_client)
        main.http_client = fake
        return fake

    def assert_default_headers(self, response: httpx.Response, *, except_for: tuple[str, ...] = ()) -> None:
        for name, value in default_headers().items():
            if name in except_for:
                continue
            self.assertEqual(response.headers.get_list(name), [value], f"{name} of {response.request.method} {response.request.url.path}")


class SecurityHeadersTests(HeadersCase):
    def test_every_answer_the_app_gives_carries_the_headers(self) -> None:
        # An API answer, a refusal, a miss, a redirect, a 409, a 413 (answered before the app) and the health probes.
        self.addCleanup(setattr, main.settings, "max_body_bytes", main.settings.max_body_bytes)
        main.settings.max_body_bytes = 10
        requests = {
            "an API JSON answer": (self.client, "GET", "/api/config", 200),
            "a 401": (self.anonymous, "GET", "/api/config", 401),
            "a refused proxy path": (self.client, "GET", "/api/eneo/x", 403),
            "an unknown path": (self.client, "GET", "/api/nope", 404),
            "a 303 redirect": (self.anonymous, "GET", "/api/auth/login", 303),
            "a 409 user_changed": (self.anonymous_session(), "POST", "/api/eneo/flows/f/runs/", 409),
            "a 413": (self.anonymous, "POST", "/api/auth/login", 413),
            "/health": (self.anonymous, "GET", "/health", 200),
            "/api/healthz": (self.anonymous, "GET", "/api/healthz", 200),
            "HEAD /health": (self.anonymous, "HEAD", "/health", 200),
        }
        for label, (client, method, path, status) in requests.items():
            with self.subTest(label):
                response = client.request(method, path, content=b"x" * 100 if status == 413 else b"{}" if method == "POST" else None)

                self.assertEqual(response.status_code, status)
                self.assert_default_headers(response)

    def anonymous_session(self) -> TestClient:
        """A session that names no user, so its write is a 409."""
        client = TestClient(main.app, raise_server_exceptions=False, follow_redirects=False)
        client.cookies.set(SESSION_COOKIE, self.client.cookies.get(SESSION_COOKIE))
        client.headers["Origin"] = ORIGIN
        return client

    def test_an_unhandled_error_carries_them_too(self) -> None:
        app = FastAPI()
        web.add_security_headers(app)

        @app.get("/boom")
        async def boom() -> None:
            raise RuntimeError("not for the client")

        response = TestClient(app, raise_server_exceptions=False).get("/boom")

        self.assertEqual((response.status_code, response.text), (500, "Internal Server Error"))
        self.assert_default_headers(response)

    def test_the_headers_are_the_one_definition_in_the_json_file(self) -> None:
        self.assertEqual(web.SECURITY_HEADERS, default_headers())
        self.assertEqual(
            set(default_headers()),
            {"Content-Security-Policy", "Referrer-Policy", "X-Content-Type-Options", "X-Frame-Options", "Permissions-Policy"},
        )

    def test_the_policy_is_strict_for_script_and_style_and_frames(self) -> None:
        policy = default_headers()["Content-Security-Policy"]
        directives = {part.split()[0]: part.split()[1:] for part in policy.split("; ")}

        self.assertEqual(directives["script-src"], ["'self'"])
        self.assertEqual(directives["style-src"], ["'self'"])
        self.assertEqual(directives["frame-ancestors"], ["'none'"])
        self.assertEqual(directives["object-src"], ["'none'"])
        self.assertNotIn("unsafe-inline", policy)
        self.assertNotIn("unsafe-eval", policy)
        self.assertEqual(default_headers()["X-Frame-Options"], "DENY")
        self.assertEqual(default_headers()["Referrer-Policy"], "no-referrer")

    def test_the_microphone_stays_on_for_this_page_and_the_dangerous_features_are_off(self) -> None:
        features = dict(part.split("=", 1) for part in default_headers()["Permissions-Policy"].split(", "))

        self.assertEqual(features.pop("microphone"), "(self)", "this module records")
        self.assertEqual(
            features,
            {name: "()" for name in ("camera", "geolocation", "display-capture", "usb", "serial", "hid", "bluetooth", "payment", "midi")},
        )

    def test_the_documentation_routes_are_gone(self) -> None:
        for path in ("/docs", "/redoc", "/docs/oauth2-redirect"):
            with self.subTest(path):
                response = self.client.get(path)

                self.assertEqual(response.status_code, 404)
                self.assertNotIn("swagger", response.text.lower())
                self.assertNotIn("redoc", response.text.lower())
        openapi = self.client.get("/openapi.json")
        self.assertEqual((openapi.status_code, openapi.json()), (404, {"detail": "Not Found"}))

    def test_health_is_a_real_route_for_get_and_head(self) -> None:
        for path in ("/health", "/api/healthz"):
            with self.subTest(path):
                got, head = self.anonymous.get(path), self.anonymous.head(path)

                self.assertEqual((got.status_code, got.json()), (200, {"ok": True}))
                self.assertEqual((head.status_code, head.content), (200, b""))


class EndpointHeadersWinTests(HeadersCase):
    """The defaults are applied with setdefault: what an endpoint says about its own answer stays."""

    ARTIFACT = "/api/eneo/flows/f/runs/r/artifacts/file-1/content"

    def test_an_inline_pdf_keeps_its_own_framing_and_no_other_answer_has_it(self) -> None:
        self.serve_files(headers={"content-type": "application/pdf", "content-disposition": 'inline; filename="a.pdf"'}, body=b"%PDF-1.7")

        pdf = self.client.get(self.ARTIFACT, params={"disposition": "inline"})

        self.assertEqual(pdf.status_code, 200)
        self.assertEqual(pdf.headers.get_list("x-frame-options"), ["SAMEORIGIN"])
        self.assertEqual(pdf.headers.get_list("content-security-policy"), ["frame-ancestors 'self'"])
        self.assert_default_headers(pdf, except_for=("X-Frame-Options", "Content-Security-Policy"))
        for other in (self.client.get("/api/config"), self.client.get(self.ARTIFACT), self.client.get("/api/nope")):
            self.assertEqual(other.headers.get_list("x-frame-options"), ["DENY"])
            self.assertNotIn("frame-ancestors 'self'", other.headers["content-security-policy"])

    def test_an_svg_logo_keeps_its_sandbox_and_gets_the_other_defaults(self) -> None:
        logo = LogoFile(media_type="image/svg+xml", content=b'<svg xmlns="http://www.w3.org/2000/svg"></svg>')
        for name in ("organization_logo", "organization_logo_dark"):
            self.addCleanup(setattr, main.settings, name, getattr(main.settings, name))
            setattr(main.settings, name, logo)

        for variant in ("light", "dark"):
            with self.subTest(variant):
                response = self.anonymous.get(f"/api/branding/logo/{variant}")

                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers.get_list("content-security-policy"), [SANDBOX])
                self.assert_default_headers(response, except_for=("Content-Security-Policy",))

    def test_a_signed_file_keeps_nosniff_and_the_disposition_the_rule_gives_it(self) -> None:
        path = "/api/eneo/flows/f/runs/r/input-files/x/audio"
        cases = {
            "inline audio": ({"content-type": "audio/webm", "content-disposition": 'inline; filename="m.webm"'}, 'inline; filename="m.webm"'),
            "an attachment": ({"content-type": "text/html", "content-disposition": 'inline; filename="x.html"'}, 'attachment; filename="x.html"'),
        }
        for label, (headers, disposition) in cases.items():
            with self.subTest(label):
                self.serve_files(headers=headers)

                response = self.client.get(path)

                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers.get_list("x-content-type-options"), ["nosniff"], "once, not twice")
                self.assertEqual(response.headers["content-disposition"], disposition)
                self.assertEqual(response.headers["cache-control"], "private, no-store")
                self.assert_default_headers(response)


class AbandonedStreamTests(unittest.TestCase):
    """A client that walks away from a streamed file must still close the module's request to Eneo, middleware or not."""

    eneo: FakeEneo
    eneo_server: Served
    module: Served

    @classmethod
    def setUpClass(cls) -> None:
        cls.eneo = FakeEneo()
        cls.eneo_server = Served(cls.eneo).__enter__()
        cls.eneo.served = cls.eneo_server
        cls.module = Served(main.app).__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.module.__exit__()
        cls.eneo_server.__exit__()

    def test_a_file_the_browser_stops_reading_closes_its_upstream(self) -> None:
        self.eneo.sent, self.eneo.outcomes = 0, []
        self.addCleanup(setattr, main.settings, "eneo_backend_url", main.settings.eneo_backend_url)
        main.settings.eneo_backend_url = self.eneo.url
        main.module_auth.sessions.clear()
        main._signed_urls.clear()
        session = a_session("token-of-a")
        mint = json.dumps({"url": f"{self.eneo.url}/files/x?sig=1", "expires_at": FAR_FUTURE}).encode()
        self.eneo.respond = lambda seen: (
            (200, [("content-type", "application/json")], mint)
            if seen.path.endswith("/signed-url/")
            else (200, [("content-type", "audio/webm")], lazy(None))
        )

        with httpx.Client(base_url=self.module.url, trust_env=False, timeout=30) as browser:
            with browser.stream(
                "GET",
                "/api/eneo/flows/f/runs/r/input-files/x/audio",
                headers={"Cookie": f"{SESSION_COOKIE}={session}", "Origin": ORIGIN},
            ) as response:
                first = next(response.iter_raw())
                self.assertEqual(response.headers["x-content-type-options"], "nosniff")
                self.assertEqual(response.headers["content-security-policy"], default_headers()["Content-Security-Policy"])
            # the response is closed: the browser is gone

        self.assertGreater(len(first), 0)
        deadline = time.time() + 10
        while self.eneo.active and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(self.eneo.outcomes, ["dropped"], "the module's request to Eneo was left open")
        self.assertLess(self.eneo.sent, 64 * MiB, "the answer was read on after the browser left")


if __name__ == "__main__":
    unittest.main()
