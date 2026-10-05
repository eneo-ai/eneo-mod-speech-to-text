"""What the backend answers as a web server: the security headers on every response, /health, and the built UI.

The header set is ``app/security_headers.json``, the one definition; a header an endpoint sets itself wins.
"""

import gzip
import html
import asyncio
import importlib.util
import json
import os
import tempfile
import time
import unittest
from html.parser import HTMLParser
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "http://localhost:3002")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")

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


class FakeAnswer:
    """What Eneo answers a proxied request with."""

    def __init__(self, content: bytes, headers: dict[str, str] | None = None, status_code: int = 200) -> None:
        self.content, self.status_code = content, status_code
        self.headers = httpx.Headers(headers or {"content-type": "application/json"})


class FakeEneoClient:
    """The module's client, in process: a signed-URL answer and a file with the headers a test chooses."""

    def __init__(self, headers: dict[str, str] | None = None, body: bytes = b"0123456789") -> None:
        self.file_headers = headers or {"content-type": "audio/webm"}
        self.body = body
        self.answer: FakeAnswer | None = None  # what a proxied request gets, when a test sets one

    async def request(self, **kwargs):
        assert self.answer is not None
        return self.answer

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
            "an API JSON answer": (self.client, "GET", "/api/auth/status", 200),
            "a 401": (self.anonymous, "GET", "/api/eneo/flows/", 401),
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
        for other in (self.client.get("/api/auth/status"), self.client.get(self.ARTIFACT), self.client.get("/api/nope")):
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


class ProxiedAnswerTests(HeadersCase):
    """What the proxy leaves of Eneo's answer: the module's own headers are not Eneo's to replace, and nothing confidential is stored."""

    FLOWS = "/api/eneo/flows/"

    def proxied(self, headers: dict[str, str]) -> httpx.Response:
        fake = self.serve_files()
        fake.answer = FakeAnswer(b'{"items": []}', {"content-type": "application/json", **headers})
        return self.client.get(self.FLOWS)

    def test_eneos_framing_policy_and_referrer_headers_never_replace_the_modules(self) -> None:
        response = self.proxied(
            {
                "x-frame-options": "SAMEORIGIN",
                "content-security-policy": "frame-ancestors 'self'",
                "permissions-policy": "microphone=*",
                "referrer-policy": "unsafe-url",
            }
        )

        self.assertEqual(response.status_code, 200)
        self.assert_default_headers(response)

    def test_the_module_owns_the_caching_of_its_origin_so_eneos_cache_control_never_reaches_the_browser(self) -> None:
        for eneo in ("public, max-age=3600", "no-cache", "private, max-age=60"):
            with self.subTest(eneo):
                self.assertEqual(self.proxied({"cache-control": eneo}).headers.get_list("cache-control"), ["no-store"])

    def test_a_proxied_answer_is_not_stored_and_a_route_that_says_how_long_keeps_its_say(self) -> None:
        self.assertEqual(self.proxied({}).headers["cache-control"], "no-store")
        self.assertEqual(self.client.get("/api/healthz").headers["cache-control"], "no-store")
        self.assertEqual(self.client.get("/api/nope").headers["cache-control"], "no-store")
        theme = self.anonymous.get("/api/branding/theme.css")
        self.assertEqual(theme.headers["cache-control"], "public, max-age=300")
        self.assertEqual(self.anonymous.get("/health").headers.get("cache-control"), None, "outside /api nothing is added")


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


MARKER = '<meta name="eneo-branding" content="">'


def branded(page: str, answer: str) -> str:
    """``page`` with its marker holding ``answer`` (the text GET /api/branding gives), escaped as an attribute value."""
    return page.replace(MARKER, f'<meta name="eneo-branding" content="{html.escape(answer, quote=True)}">')


INDEX = (
    '<!doctype html><html lang="sv"><head><title>Tal till text</title>' + MARKER + '</head>'
    '<body><div id="root"></div></body></html>'
)


def load_app(static_dir: Path | None, **environment: str):
    """A second, complete copy of the app (``app.main`` run again) configured with STATIC_DIR, as the launcher runs it.

    The routes, the middleware and the fallback are the real ones; nothing is added to the app the other tests use.
    """
    spec = importlib.util.spec_from_file_location("app_main_with_ui", Path(main.__file__))
    module = importlib.util.module_from_spec(spec)
    variables = {key: value for key, value in os.environ.items() if key not in ("STATIC_DIR", "ORGANIZATION_NAME", "SHOW_ORGANIZATION")}
    if static_dir is not None:
        variables["STATIC_DIR"] = str(static_dir)
    with patch.dict(os.environ, {**variables, **environment}, clear=True):
        spec.loader.exec_module(module)
    return module


class BuiltUiCase(unittest.TestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name) / "dist"
        (self.root / "assets").mkdir(parents=True)
        (self.root / "brand").mkdir()
        (self.root / "index.html").write_text(INDEX)
        (self.root / "assets" / "app.js").write_text("console.log(1)")
        # Siblings, as the build writes them (the .br is not real brotli: no test client here asks for it unasked).
        (self.root / "assets" / "app.js.br").write_bytes(b"not really brotli")
        (self.root / "assets" / "app.js.gz").write_bytes(gzip.compress(b"console.log(1)"))
        (self.root / "assets" / "app.css").write_text("body{}")
        (self.root / "favicon.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
        (self.root / "live-pcm-worklet.js").write_text("registerProcessor('pcm', class {})")
        (self.root / "brand" / "mark.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
        # Beside the built UI, not in it: nothing may reach this.
        (Path(folder.name) / "secret.txt").write_text("secret")
        self.module = load_app(self.root)
        self.client = TestClient(self.module.app, raise_server_exceptions=False, follow_redirects=False)
        # What the page is: the file with its marker holding what GET /api/branding answers.
        self.page = branded(INDEX, self.client.get("/api/branding").text)

    def restarted(self) -> TestClient:
        """The app started again on the folder as it is now: the files are indexed once, at start, so a test that adds
        a file and expects it to be refused (or served) starts the app after adding it."""
        return TestClient(load_app(self.root).app, raise_server_exceptions=False, follow_redirects=False)

    def raw_get(self, path: str) -> httpx.Response:
        """A GET with ``path`` as the server receives it. The test client's URL parser reads ``//api/x`` as a host and
        resolves ``/./``, so a path that is not canonical goes to the app directly."""
        sent: list[dict] = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            sent.append(message)

        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET", "scheme": "http", "root_path": "",
            "path": path, "raw_path": path.encode(), "query_string": b"", "headers": [(b"host", b"testserver")],
            "client": ("127.0.0.1", 1), "server": ("testserver", 80),
        }
        asyncio.run(self.module.app(scope, receive, send))
        start = next(message for message in sent if message["type"] == "http.response.start")
        body = b"".join(message.get("body", b"") for message in sent if message["type"] == "http.response.body")
        return httpx.Response(start["status"], headers=start["headers"], content=body)


class StaticServingTests(BuiltUiCase):
    def test_every_route_of_the_app_is_the_page_revalidated_with_an_etag(self) -> None:
        for path in ("/", "/flows", "/flows/", "/flows/abc", "/flows/abc/", "/flows/abc?run=r", "/inloggad", "/inloggad?fel=utgangen", "/a/b/c", "/assets"):
            with self.subTest(path=path):
                response = self.client.get(path)

                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.text, self.page)
                self.assertTrue(response.headers["content-type"].startswith("text/html"))
                self.assertEqual(response.headers["cache-control"], "no-cache")
                self.assertRegex(response.headers["etag"], r'^"[0-9a-f]{16}"$')

    def test_a_revalidation_of_the_page_is_a_304_with_the_same_headers(self) -> None:
        first = self.client.get("/flows/abc")

        again = self.client.get("/flows/abc", headers={"If-None-Match": first.headers["etag"]})

        self.assertEqual((again.status_code, again.content), (304, b""))
        self.assertEqual(again.headers["etag"], first.headers["etag"])
        self.assertEqual(again.headers["cache-control"], "no-cache")
        for name, value in default_headers().items():
            self.assertEqual(again.headers[name], value, name)
        stale = self.client.get("/flows/abc", headers={"If-None-Match": '"0000000000000000"'})
        self.assertEqual(stale.status_code, 200)

    def test_index_html_is_the_same_processed_page(self) -> None:
        page, index = self.client.get("/"), self.client.get("/index.html")

        self.assertEqual((index.status_code, index.text, index.headers["etag"]), (200, page.text, page.headers["etag"]))
        self.assertEqual(index.headers["cache-control"], "no-cache")

    def test_the_api_and_every_unknown_api_path_is_404_json_never_the_page(self) -> None:
        for path in ("/api", "/api/", "/api/nope", "/api/auth/nope/deeper", "/api/eneo", "/api/config", "/api/live"):
            with self.subTest(path=path):
                response = self.client.get(path)

                self.assertEqual(response.status_code, 404)
                self.assertTrue(response.headers["content-type"].startswith("application/json"))
                self.assertEqual(response.json(), {"detail": "Not Found"})
                self.assertNotIn("<title>", response.text)

    def test_a_write_to_an_unknown_path_is_a_json_refusal_never_the_page(self) -> None:
        for method, path in (("POST", "/api/nope"), ("POST", "/nope"), ("DELETE", "/flows/abc")):
            with self.subTest(method=method, path=path):
                response = self.client.request(method, path)

                self.assertIn(response.status_code, (404, 405))
                self.assertTrue(response.headers["content-type"].startswith("application/json"))

    def test_an_asset_is_immutable_and_a_missing_one_is_404_json(self) -> None:
        asset = self.client.get("/assets/app.js")

        self.assertEqual(asset.status_code, 200)
        self.assertEqual(asset.headers["cache-control"], "public, max-age=31536000, immutable")
        self.assertTrue(asset.headers["content-type"].startswith("text/javascript"))
        self.assertEqual(asset.text, "console.log(1)")
        for path in ("/assets/x.js", "/assets/nope/x.js", "/logo.png", "/a/b/style.css", "/favicon.ico", "/x.js"):
            with self.subTest(path=path):
                response = self.client.get(path)

                self.assertEqual(response.status_code, 404)
                self.assertTrue(response.headers["content-type"].startswith("application/json"))
                self.assertNotIn("<title>", response.text)

    def test_a_file_at_the_root_is_served_and_revalidated(self) -> None:
        worklet = self.client.get("/live-pcm-worklet.js")

        self.assertEqual(worklet.status_code, 200)
        self.assertTrue(worklet.headers["content-type"].startswith("text/javascript"))
        self.assertEqual(worklet.headers["cache-control"], "no-cache")
        self.assertTrue(worklet.headers["etag"])
        again = self.client.get("/live-pcm-worklet.js", headers={"If-None-Match": worklet.headers["etag"]})
        self.assertEqual((again.status_code, again.content), (304, b""))
        mark = self.client.get("/brand/mark.svg")
        self.assertEqual((mark.status_code, mark.headers["content-type"].split(";")[0]), (200, "image/svg+xml"))
        self.assertEqual(self.client.get("/favicon.svg").status_code, 200)

    def test_a_file_added_after_the_start_is_a_404(self) -> None:
        # dist/ is immutable per image: the files are indexed once, when the app starts, and nothing else is served.
        (self.root / "late.js").write_text("late")
        (self.root / "assets" / "late.js").write_text("late")
        (self.root / "brand" / "late.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
        for path in ("/late.js", "/assets/late.js", "/brand/late.svg"):
            with self.subTest(path=path):
                response = self.client.get(path)

                self.assertEqual((response.status_code, response.json()), (404, {"detail": "Not Found"}))
        # A compressed sibling that arrives later is not offered either: the file is what it was.
        (self.root / "assets" / "app.css.gz").write_bytes(gzip.compress(b"body{}"))
        response = self.client.get("/assets/app.css", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(response.text, "body{}")
        self.assertNotIn("content-encoding", response.headers)
        self.assertNotIn("vary", response.headers)

    def test_a_request_does_no_stat_and_no_resolve(self) -> None:
        # The files are known from the start: a request looks its path up and touches the file system for nothing else
        # than reading what it serves. (It was a resolve, an is_file and the sibling checks per request, on the loop.)
        requests = (
            ("/", {}), ("/flows/abc", {}), ("/index.html", {}), ("/assets/app.js", {}), ("/assets/app.css", {}), ("/favicon.svg", {}),
            ("/live-pcm-worklet.js", {}), ("/brand/mark.svg", {}), ("/assets/app.js", {"Accept-Encoding": "br"}),
            ("/assets/app.js", {"Accept-Encoding": "gzip"}), ("/assets/missing.js", {}), ("/assets/app.js.br", {}), ("/.env", {}),
        )
        for path, headers in requests:  # once before the spies: the first use of a library may stat for itself
            self.client.get(path, headers=headers)
        tags = {path: self.client.get(path).headers["etag"] for path in ("/", "/assets/app.js", "/favicon.svg")}
        calls: list[tuple[str, str]] = []
        resolve, stat = Path.resolve, os.stat

        def spy_resolve(path, *args, **kwargs):
            calls.append(("resolve", str(path)))
            return resolve(path, *args, **kwargs)

        def spy_stat(path, *args, **kwargs):
            calls.append(("stat", str(path)))
            return stat(path, *args, **kwargs)

        with patch.object(Path, "resolve", spy_resolve), patch("os.stat", spy_stat):
            for path, headers in requests:
                self.client.get(path, headers=headers)
            for path, tag in tags.items():
                self.assertEqual(self.client.get(path, headers={"If-None-Match": tag}).status_code, 304)
                self.assertEqual(self.client.head(path).status_code, 200)

        self.assertEqual(calls, [])

    def test_a_folder_with_no_page_serves_its_files_and_no_page(self) -> None:
        # The launcher is what refuses to start without index.html (test_serve.py); the app itself answers what it has.
        (self.root / "index.html").unlink()
        client = self.restarted()

        self.assertEqual(client.get("/assets/app.js").text, "console.log(1)")
        for path in ("/", "/flows/abc", "/index.html"):
            self.assertEqual(client.get(path).status_code, 404, path)

    def test_precompressed_files_are_served_only_by_negotiation_never_by_name(self) -> None:
        for path in ("/assets/app.js.br", "/assets/app.js.gz", "/index.html.br", "/favicon.svg.gz"):
            with self.subTest(path=path):
                response = self.client.get(path)

                self.assertEqual(response.status_code, 404)
                self.assertNotIn("not really", response.text)
                self.assertNotIn("content-encoding", response.headers)

    def test_a_path_cannot_leave_the_built_ui_and_none_is_a_500(self) -> None:
        for path in (
            "/../secret.txt",
            "/%2E%2E/secret.txt",
            "/..%2Fsecret.txt",
            "/%2E%2E%2Fsecret.txt",
            "/assets/%2E%2E/secret.txt",
            "/assets/..%2F..%2Fsecret.txt",
            "/x/%2E%2E/%2E%2E/secret.txt",
            "/..%5Csecret.txt",
            "/assets/..%5C..%5Csecret.txt",
            "/" + "a" * 5000 + ".js",
            "/assets/" + "a" * 5000,
        ):
            with self.subTest(path=path[:60]):
                response = self.client.get(path)

                self.assertNotIn("secret", response.text)
                self.assertIn(response.status_code, (200, 400, 404))
                if response.status_code == 200:
                    self.assertEqual(response.text, self.page, "the only 200 is the page, for a path with no extension")

    def test_a_control_character_or_a_backslash_anywhere_in_the_path_is_a_404_json_never_the_page(self) -> None:
        for path in (
            "/%00", "/a%00", "/flows/%00", "/a%00.js", "/assets/a%00.js",  # NUL
            "/%01", "/flows/%1f", "/%0a", "/%0d", "/a%09b", "/flows/a%7f",  # the rest of C0, and DEL
            "/%5Cb", "/flows/a%5Cb", "/a%5Cb.js",  # a backslash
        ):
            with self.subTest(path=path):
                response = self.client.get(path)

                self.assertEqual((response.status_code, response.json()), (404, {"detail": "Not Found"}))
        for path in ("/a%20b", "/fl%C3%B6de/%C3%A5", "/flows/abc"):  # a space, and letters outside ASCII, are names
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).text, self.page)

    def test_a_path_that_is_not_canonical_is_never_the_page_in_place_of_an_api_404(self) -> None:
        for path in ("//api/x", "///api/x", "//api", "/./api/x", "/../api/x", "/a/../api/x", "/flows/./x", "/flows/../x"):
            with self.subTest(path=path):
                response = self.raw_get(path)

                self.assertEqual((response.status_code, response.json()), (404, {"detail": "Not Found"}))
        self.assertEqual(self.raw_get("/flows/abc").text, self.page)

    def test_a_dotfile_is_never_served(self) -> None:
        (self.root / ".hidden").write_text("hidden-content")
        (self.root / "assets" / ".DS_Store").write_text("hidden-content")
        client = self.restarted()  # the dotfiles are there when the app starts, and still never served
        for path in ("/.hidden", "/assets/.DS_Store", "/.env", "/.git/config", "/assets/.hidden.js", "/a/.b"):
            with self.subTest(path=path):
                response = client.get(path)

                self.assertEqual((response.status_code, response.json()), (404, {"detail": "Not Found"}))
                self.assertNotIn("hidden-content", response.text)

    def test_a_file_has_one_url_and_a_sibling_is_not_served_by_the_twin_of_its_name_with_a_slash(self) -> None:
        for path in ("/assets/app.js/", "/assets/app.css/", "/assets/app.js.br/", "/assets/app.js.gz/", "/assets/"):
            with self.subTest(path=path):
                response = self.client.get(path)

                self.assertEqual((response.status_code, response.json()), (404, {"detail": "Not Found"}))
                self.assertNotIn("not really", response.text)
        self.assertEqual(self.client.get("/assets/app.js").status_code, 200)
        # Outside assets/ a path ending in a slash is a route of the app, as any other: the page, never a file or its sibling.
        for path in ("/flows/", "/index.html.br/", "/favicon.svg.gz/"):
            with self.subTest(path=path):
                response = self.client.get(path)

                self.assertEqual((response.status_code, response.text), (200, self.page))
                self.assertNotIn("content-encoding", response.headers)

    def test_a_path_that_resolves_outside_through_a_link_is_404(self) -> None:
        (self.root / "link.txt").symlink_to(self.root.parent / "secret.txt")

        response = self.restarted().get("/link.txt")  # the link is there when the app starts, and still never followed

        self.assertEqual(response.status_code, 404)
        self.assertNotIn("secret", response.text)

    def test_head_is_answered_like_get_without_a_body(self) -> None:
        for path in ("/", "/flows/abc", "/health", "/api/healthz", "/assets/app.js", "/live-pcm-worklet.js"):
            with self.subTest(path=path):
                got, head = self.client.get(path), self.client.head(path)

                self.assertEqual(head.status_code, got.status_code)
                self.assertEqual(head.content, b"")
                self.assertEqual(head.headers.get("etag"), got.headers.get("etag"))

    def test_the_modules_own_routes_win_over_the_fallback(self) -> None:
        for path in ("/health", "/api/healthz"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).json(), {"ok": True})
        self.assertIn("organization", self.client.get("/api/branding").json())
        theme = self.client.get("/api/branding/theme.css")
        self.assertEqual((theme.status_code, theme.headers["content-type"].split(";")[0]), (200, "text/css"))
        # The route's own answers, not the fallback's: a session check, and "no logo is configured".
        self.assertEqual(self.client.get("/api/eneo/flows/").status_code, 401)
        self.assertEqual(self.client.get("/api/branding/logo/light").json(), {"detail": "No logo is configured"})

    def test_every_answer_of_the_ui_carries_the_security_headers(self) -> None:
        for path in ("/", "/flows/abc", "/assets/app.js", "/assets/nope.js", "/favicon.svg", "/nope.png", "/api/nope", "/health", "/..%2Fsecret.txt"):
            with self.subTest(path=path):
                response = self.client.get(path)

                for name, value in default_headers().items():
                    self.assertEqual(response.headers.get_list(name), [value], f"{name} on {path}")

    def test_health_answers_json_even_for_a_folder_with_no_page(self) -> None:
        # The launcher refuses to start without index.html; the route is not what checks it.
        empty = tempfile.TemporaryDirectory()
        self.addCleanup(empty.cleanup)
        client = TestClient(load_app(Path(empty.name)).app, raise_server_exceptions=False)

        self.assertEqual(client.get("/health").json(), {"ok": True})
        self.assertEqual(client.get("/api/healthz").json(), {"ok": True})
        self.assertEqual(client.get("/").status_code, 404)

    def test_without_a_static_dir_the_app_serves_no_page_and_nothing_else_changes(self) -> None:
        client = TestClient(load_app(None).app, raise_server_exceptions=False)

        for path in ("/", "/flows/abc", "/index.html", "/assets/app.js"):
            with self.subTest(path=path):
                self.assertEqual(client.get(path).status_code, 404)
        self.assertEqual(client.get("/health").json(), {"ok": True})
        self.assertEqual(client.get("/api/nope").json(), {"detail": "Not Found"})


PLAIN_JS = "console.log('plain')"


class JsonCompressionTests(HeadersCase):
    """A large JSON answer of the proxy is compressed for a client that accepts it, and nothing else is ever touched."""

    LARGE = json.dumps({"items": [{"id": f"flow-{n}", "name": "Nämndmöte till rapport", "description": "x" * 40} for n in range(2000)]}).encode()
    FLOWS = "/api/eneo/flows/"

    def proxied(self, answer: FakeAnswer) -> FakeEneoClient:
        fake = self.serve_files()
        fake.answer = answer
        return fake

    def raw(self, path: str, **headers: str) -> tuple[httpx.Response, bytes]:
        """The answer and its body as it went over the wire (undecoded)."""
        with self.client.stream("GET", path, headers=headers) as response:
            return response, b"".join(response.iter_raw())

    def test_a_large_json_answer_is_compressed_for_a_client_that_accepts_gzip(self) -> None:
        self.proxied(FakeAnswer(self.LARGE, {"content-type": "application/json", "etag": '"v1"'}))

        response, body = self.raw(self.FLOWS, **{"Accept-Encoding": "gzip"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-encoding"], "gzip")
        self.assertEqual(response.headers["vary"], "Accept-Encoding")
        self.assertEqual(response.headers["content-type"], "application/json")
        self.assertEqual(gzip.decompress(body), self.LARGE)
        self.assertLess(len(body), len(self.LARGE) // 5, "it is not compressed in name only")
        self.assertEqual(int(response.headers["content-length"]), len(body))
        self.assertEqual(response.headers["etag"], 'W/"v1"', "a different body: its validator is weak")
        self.assert_default_headers(response)

    def test_the_browser_gets_the_json_back_whole(self) -> None:
        self.proxied(FakeAnswer(self.LARGE))

        response = self.client.get(self.FLOWS, headers={"Accept-Encoding": "gzip"})  # httpx decodes it

        self.assertEqual(response.content, self.LARGE)

    def test_a_json_answer_with_a_content_type_parameter_or_a_json_suffix_is_compressed_too(self) -> None:
        for content_type in ("application/json; charset=utf-8", "Application/JSON", "application/problem+json"):
            with self.subTest(content_type):
                self.proxied(FakeAnswer(self.LARGE, {"content-type": content_type}))

                response, body = self.raw(self.FLOWS, **{"Accept-Encoding": "gzip"})

                self.assertEqual(response.headers["content-encoding"], "gzip")
                self.assertEqual(gzip.decompress(body), self.LARGE)

    def test_a_small_json_answer_is_plain(self) -> None:
        small = b'{"ok": true}'
        self.proxied(FakeAnswer(small))

        response, body = self.raw(self.FLOWS, **{"Accept-Encoding": "gzip"})

        self.assertEqual((response.status_code, body), (200, small))
        self.assertNotIn("content-encoding", response.headers)

    def test_a_client_that_accepts_neither_gets_the_plain_json_and_the_caches_are_told_it_varies(self) -> None:
        self.proxied(FakeAnswer(self.LARGE))
        for accept in ("", "identity", "deflate", "gzip;q=0", "br"):
            with self.subTest(accept=accept):
                response, body = self.raw(self.FLOWS, **{"Accept-Encoding": accept})

                self.assertEqual(body, self.LARGE)
                self.assertNotIn("content-encoding", response.headers)
                self.assertEqual(response.headers["vary"], "Accept-Encoding")

    def test_only_json_is_compressed(self) -> None:
        for content_type in ("text/plain", "application/pdf", "audio/webm", "application/octet-stream", "text/html", "application/jsonlines-not"):
            with self.subTest(content_type):
                self.proxied(FakeAnswer(self.LARGE, {"content-type": content_type}))

                response, body = self.raw(self.FLOWS, **{"Accept-Encoding": "gzip"})

                self.assertEqual(body, self.LARGE)
                self.assertNotIn("content-encoding", response.headers)
                self.assertNotIn("vary", response.headers)

    def test_a_partial_or_already_encoded_answer_and_a_range_request_are_left_alone(self) -> None:
        cases = {
            "a 206": (FakeAnswer(self.LARGE, status_code=206), {}),
            "a Content-Range": (FakeAnswer(self.LARGE, {"content-type": "application/json", "content-range": "bytes 0-9/10"}), {}),
            "already encoded": (FakeAnswer(self.LARGE, {"content-type": "application/json", "content-encoding": "br"}), {}),
            "a Range request": (FakeAnswer(self.LARGE), {"Range": "bytes=0-99"}),
            "a 304": (FakeAnswer(b"", {"content-type": "application/json", "etag": '"v1"'}, status_code=304), {}),
        }
        for label, (answer, extra) in cases.items():
            with self.subTest(label):
                self.proxied(answer)

                response, body = self.raw(self.FLOWS, **{"Accept-Encoding": "gzip", **extra})

                self.assertEqual(body, answer.content)
                # (The proxy has never passed Eneo's Content-Encoding on: the client refuses an encoded answer.)
                self.assertNotIn("content-encoding", response.headers)
                self.assertNotIn("vary", response.headers)
                self.assertEqual(response.headers.get("etag"), answer.headers.get("etag"))

    def test_a_streamed_signed_file_is_never_compressed_and_keeps_its_range(self) -> None:
        # Audio, a PDF and a file that happens to be JSON: the signed-file route streams them as Eneo sends them.
        path = "/api/eneo/flows/f/runs/r/input-files/x/audio"
        for content_type, body in (("audio/webm", b"A" * 5000), ("application/pdf", b"%PDF" + b"B" * 5000), ("application/json", self.LARGE)):
            with self.subTest(content_type):
                self.serve_files(headers={"content-type": content_type, "content-range": "bytes 0-9/99", "accept-ranges": "bytes"}, body=body)

                response, raw = self.raw(path, **{"Accept-Encoding": "gzip", "Range": "bytes=0-9"})

                self.assertEqual(raw, body)
                self.assertNotIn("content-encoding", response.headers)
                self.assertNotIn("vary", response.headers)
                self.assertEqual((response.headers["content-range"], response.headers["accept-ranges"]), ("bytes 0-9/99", "bytes"))


class PrecompressedTests(BuiltUiCase):
    """A file with a .br or .gz beside it is served compressed to a client that accepts it, by negotiation only."""

    def setUp(self) -> None:
        super().setUp()
        (self.root / "assets" / "app.js").write_text(PLAIN_JS)
        (self.root / "assets" / "app.js.br").write_bytes(b"BROTLI-BYTES")
        (self.root / "assets" / "app.js.gz").write_bytes(gzip.compress(PLAIN_JS.encode()))
        (self.root / "assets" / "app.css").write_text("body{}")  # no compressed sibling
        (self.root / "index.html.br").write_bytes(b"BROTLI-PAGE")
        (self.root / "index.html.gz").write_bytes(gzip.compress(INDEX.encode()))
        self.client = TestClient(load_app(self.root).app, raise_server_exceptions=False, follow_redirects=False)

    def raw(self, path: str, **headers: str) -> tuple[httpx.Response, bytes]:
        """The answer and its body exactly as it went over the wire (undecoded)."""
        with self.client.stream("GET", path, headers=headers) as response:
            return response, b"".join(response.iter_raw())

    def test_brotli_is_served_to_a_client_that_accepts_it(self) -> None:
        response, body = self.raw("/assets/app.js", **{"Accept-Encoding": "br, gzip"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(body, b"BROTLI-BYTES")
        self.assertEqual(response.headers["content-encoding"], "br")
        self.assertEqual(response.headers["vary"], "Accept-Encoding")
        self.assertTrue(response.headers["content-type"].startswith("text/javascript"))
        self.assertEqual(response.headers["cache-control"], "public, max-age=31536000, immutable")

    def test_gzip_is_served_when_it_is_all_that_is_accepted(self) -> None:
        for accept in ("gzip", "gzip, deflate", "br;q=0, gzip", "identity, gzip;q=0.5"):
            with self.subTest(accept=accept):
                response, body = self.raw("/assets/app.js", **{"Accept-Encoding": accept})

                self.assertEqual(response.headers["content-encoding"], "gzip")
                self.assertEqual(gzip.decompress(body).decode(), PLAIN_JS)
                self.assertEqual(response.headers["vary"], "Accept-Encoding")
                self.assertTrue(response.headers["content-type"].startswith("text/javascript"))

    def test_a_client_that_accepts_neither_gets_the_plain_file_and_the_caches_are_told_it_varies(self) -> None:
        for accept in ("", "identity", "deflate", "br;q=0, gzip;q=0"):
            with self.subTest(accept=accept):
                response, body = self.raw("/assets/app.js", **{"Accept-Encoding": accept})

                self.assertEqual(body.decode(), PLAIN_JS)
                self.assertNotIn("content-encoding", response.headers)
                self.assertEqual(response.headers["vary"], "Accept-Encoding")

    def test_each_encoding_has_its_own_etag_and_a_revalidation_is_a_304_that_says_so(self) -> None:
        brotli, _ = self.raw("/assets/app.js", **{"Accept-Encoding": "br"})
        gzipped, _ = self.raw("/assets/app.js", **{"Accept-Encoding": "gzip"})
        plain, _ = self.raw("/assets/app.js", **{"Accept-Encoding": "identity"})

        self.assertEqual(len({brotli.headers["etag"], gzipped.headers["etag"], plain.headers["etag"]}), 3)
        again = self.client.get("/assets/app.js", headers={"Accept-Encoding": "br", "If-None-Match": brotli.headers["etag"]})
        self.assertEqual((again.status_code, again.content), (304, b""))
        self.assertEqual(again.headers["vary"], "Accept-Encoding")

    def test_a_compressed_file_is_read_off_the_event_loop(self) -> None:
        # Reading a few hundred KB blocks whoever is on the loop: the live relay shares it.
        where: list[str] = []
        read_bytes = Path.read_bytes

        def spy(path: Path) -> bytes:
            if path.suffix in (".br", ".gz"):
                try:
                    asyncio.get_running_loop()
                    where.append("on the event loop")
                except RuntimeError:  # a worker thread has no running loop
                    where.append("in a worker thread")
            return read_bytes(path)

        with patch.object(Path, "read_bytes", spy):
            for encoding in ("br", "gzip"):
                self.raw("/assets/app.js", **{"Accept-Encoding": encoding})

        self.assertEqual(where, ["in a worker thread"] * 2)

    def test_a_range_of_a_compressed_file_is_answered_whole(self) -> None:
        # A range of a compressed file is not a range of the file.
        response, body = self.raw("/assets/app.js", **{"Accept-Encoding": "br", "Range": "bytes=0-3"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(body, b"BROTLI-BYTES")
        self.assertNotIn("content-range", response.headers)

    def test_a_file_without_a_compressed_sibling_is_served_as_it_is(self) -> None:
        response, body = self.raw("/assets/app.css", **{"Accept-Encoding": "br, gzip"})

        self.assertEqual((response.status_code, body), (200, b"body{}"))
        self.assertNotIn("content-encoding", response.headers)
        self.assertNotIn("vary", response.headers)

    def test_the_page_itself_is_never_precompressed(self) -> None:
        for path in ("/", "/flows/abc", "/index.html"):
            with self.subTest(path=path):
                response, body = self.raw(path, **{"Accept-Encoding": "br, gzip"})

                self.assertEqual(response.status_code, 200)
                self.assertNotIn("content-encoding", response.headers)
                self.assertIn(b"<title>Tal till text</title>", body)

    def test_the_sibling_is_never_served_by_its_own_name(self) -> None:
        for path in ("/assets/app.js.br", "/assets/app.js.gz", "/assets/app.js.br/", "/assets/app.js.gz/"):
            self.assertEqual(self.client.get(path, headers={"Accept-Encoding": "br, gzip"}).status_code, 404)
        twin = self.client.get("/index.html.br/", headers={"Accept-Encoding": "br, gzip"})
        self.assertEqual((twin.status_code, twin.headers.get("content-encoding")), (200, None))
        self.assertNotIn(b"BROTLI-PAGE", twin.content, "a route of the app: the page, not the sibling")


class BrandingMarkerTests(BuiltUiCase):
    """The page holds the organisation, written into it once at start, so the first frame already shows the mark."""

    def page_with(self, **environment: str) -> tuple[httpx.Response, str]:
        client = TestClient(load_app(self.root, **environment).app, raise_server_exceptions=False)
        return client.get("/"), client.get("/api/branding").text

    @staticmethod
    def read(response: httpx.Response) -> tuple[list[str], list[tuple[str, str]]]:
        """What an HTML parser makes of the page: the tags in it, and the content of each branding meta."""

        class Reader(HTMLParser):
            def __init__(self) -> None:
                super().__init__()
                self.tags: list[str] = []
                self.contents: list[tuple[str, str]] = []

            def handle_starttag(self, tag: str, attributes: list[tuple[str, str | None]]) -> None:
                self.tags.append(tag)
                found = dict(attributes)
                if tag == "meta" and found.get("name") == "eneo-branding":
                    self.contents.append(("eneo-branding", found.get("content") or ""))

        reader = Reader()
        reader.feed(response.text)
        return reader.tags, reader.contents

    def attribute(self, response: httpx.Response) -> str:
        _, contents = self.read(response)
        self.assertEqual(len(contents), 1)
        return contents[0][1]

    def test_the_default_organisation_is_in_the_page_as_the_branding_endpoint_answers_it(self) -> None:
        response, answer = self.page_with()

        self.assertEqual(self.attribute(response), answer)
        self.assertEqual(json.loads(answer)["organization"]["name"], "Sundsvalls kommun")
        self.assertEqual(response.text, branded(INDEX, answer))

    def test_a_named_organisation_is_in_the_page(self) -> None:
        response, answer = self.page_with(ORGANIZATION_NAME="Umeå kommun")

        self.assertEqual(self.attribute(response), answer)
        self.assertEqual(json.loads(self.attribute(response)), {"organization": {"name": "Umeå kommun", "logo": None, "dark_logo": False, "logo_sizes": None}})

    def test_the_logos_sizes_are_in_the_page_so_the_header_does_not_move_when_they_arrive(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            light, dark = Path(folder, "logo.svg"), Path(folder, "logo-dark.svg")
            light.write_bytes(b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 48"></svg>')
            dark.write_bytes(b'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40"></svg>')

            response, answer = self.page_with(ORGANIZATION_NAME="Umeå kommun", ORGANIZATION_LOGO=str(light), ORGANIZATION_LOGO_DARK=str(dark))

        self.assertEqual(self.attribute(response), answer)
        self.assertEqual(
            json.loads(answer)["organization"],
            {
                "name": "Umeå kommun",
                "logo": "custom",
                "dark_logo": True,
                "logo_sizes": {"light": {"width": 600, "height": 48}, "dark": {"width": 160, "height": 40}},
            },
        )

    def test_no_organisation_is_in_the_page_as_null(self) -> None:
        response, answer = self.page_with(SHOW_ORGANIZATION="false")

        self.assertEqual(self.attribute(response), answer)
        self.assertEqual(json.loads(answer), {"organization": None})

    def test_a_name_with_quotes_brackets_and_ampersands_cannot_break_out_of_the_attribute(self) -> None:
        name = "A \"B\" <script>x</script> & 'C' </head>"
        response, answer = self.page_with(ORGANIZATION_NAME=name)

        tags, _ = self.read(response)
        self.assertEqual(json.loads(self.attribute(response))["organization"]["name"], name)
        self.assertEqual(self.attribute(response), answer)
        self.assertEqual(tags, ["html", "head", "title", "meta", "body", "div"], "no element came out of the name")
        self.assertNotIn("<script", response.text)
        self.assertEqual(response.text.count("</head>"), 1)

    def test_different_organisations_have_different_etags_and_the_same_one_the_same(self) -> None:
        first, _ = self.page_with(ORGANIZATION_NAME="Umeå kommun")
        second, _ = self.page_with(ORGANIZATION_NAME="Luleå kommun")
        again, _ = self.page_with(ORGANIZATION_NAME="Umeå kommun")

        self.assertNotEqual(first.headers["etag"], second.headers["etag"])
        self.assertEqual(first.headers["etag"], again.headers["etag"])

    def test_a_page_without_the_marker_or_with_two_stops_the_start_and_names_the_file(self) -> None:
        for label, text in {"none": INDEX.replace(MARKER, ""), "two": INDEX.replace(MARKER, MARKER + MARKER), "filled": INDEX.replace('content=""', 'content="x"')}.items():
            with self.subTest(label):
                (self.root / "index.html").write_text(text)

                with self.assertRaises(RuntimeError) as refused:
                    load_app(self.root)

                self.assertIn(str(self.root / "index.html"), str(refused.exception))
                self.assertIn("eneo-branding", str(refused.exception))


if __name__ == "__main__":
    unittest.main()
