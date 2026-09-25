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
CONTENT = "/api/eneo/flows/flow-1/runs/run-1/artifacts/file-1/content"
# What Eneo sends once it names files itself (eneo-ewq1): an ASCII fallback and the UTF-8 name.
ENEO_DISPOSITION = (
    'attachment; filename="Namndmote till rapport 2026-09-23.pdf"; '
    "filename*=UTF-8''N%C3%A4mndm%C3%B6te%20till%20rapport%202026-09-23.pdf"
)


class FakeResponse:
    def __init__(self, status_code: int, payload: dict[str, object]) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class FakeStreamResponse:
    def __init__(self, headers: dict[str, str], body: bytes) -> None:
        self.status_code = 200
        self.headers = httpx.Headers(headers)
        self._body = body

    async def aiter_raw(self):
        yield self._body

    async def aclose(self):
        pass


class FakeEneo:
    def __init__(self, content_type: str = "application/pdf", mint_status: int = 200) -> None:
        self.content_type = content_type
        self.disposition: str | None = ENEO_DISPOSITION
        self.mint_status = mint_status
        self.mint_calls: list[dict[str, object]] = []
        self.stream_requests: list[httpx.Request] = []

    async def post(self, url, **kwargs):
        self.mint_calls.append({"url": url, **kwargs})
        if self.mint_status != 200:
            return FakeResponse(self.mint_status, {"code": "flow_run_artifact_content_unavailable"})
        return FakeResponse(200, {"url": SIGNED, "expires_at": int(time.time()) + 900})

    def build_request(self, method, url, headers=None):
        return httpx.Request(method, url, headers=headers)

    async def send(self, request, stream=False):
        self.stream_requests.append(request)
        headers = {"content-type": self.content_type, "content-length": "8", "set-cookie": "leak=1"}
        if self.disposition is not None:
            headers["content-disposition"] = self.disposition
        return FakeStreamResponse(headers, b"%PDF-1.7")


class ArtifactProxyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_client = main.http_client
        self.fake = FakeEneo()
        main.http_client = self.fake
        main._signed_urls.clear()
        self.client = TestClient(main.app)
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

    def test_a_pdf_opens_inline_under_eneos_name_in_a_same_origin_frame(self) -> None:
        response = self.client.get(CONTENT, params={"disposition": "inline"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"%PDF-1.7")
        self.assertEqual(response.headers["content-type"], "application/pdf")
        self.assertEqual(
            response.headers["content-disposition"],
            'inline; filename="Namndmote till rapport 2026-09-23.pdf"; '
            "filename*=UTF-8''N%C3%A4mndm%C3%B6te%20till%20rapport%202026-09-23.pdf",
        )
        self.assertEqual(response.headers["x-frame-options"], "SAMEORIGIN")
        self.assertEqual(response.headers["content-security-policy"], "frame-ancestors 'self'")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.assertNotIn("set-cookie", response.headers)

        # Minted upstream with the module's credentials; the browser never sees the URL.
        self.assertEqual(len(self.fake.mint_calls), 1)
        call = self.fake.mint_calls[0]
        self.assertEqual(
            call["url"],
            "https://eneo.example.test/api/v1/flows/flow-1/runs/run-1/artifacts/file-1/signed-url/",
        )
        self.assertEqual(call["headers"]["Authorization"], "Bearer module-user-token")
        self.assertEqual(str(self.fake.stream_requests[0].url), SIGNED)

    def test_a_download_is_an_attachment_under_eneos_name(self) -> None:
        response = self.client.get(CONTENT, params={"disposition": "attachment"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-disposition"], ENEO_DISPOSITION)
        self.assertNotIn("x-frame-options", response.headers)

    def test_eneo_names_the_file_and_the_page_cannot_rename_it(self) -> None:
        self.fake.disposition = 'attachment; filename="step_4_output.pdf"'

        response = self.client.get(CONTENT, params={"filename": "Annat namn.pdf"})

        self.assertEqual(response.headers["content-disposition"], 'attachment; filename="step_4_output.pdf"; filename*=UTF-8\'\'step_4_output.pdf')

    def test_without_a_name_from_eneo_the_module_invents_none(self) -> None:
        self.fake.disposition = None

        response = self.client.get(CONTENT)

        self.assertEqual(response.headers["content-disposition"], "attachment")

    def test_only_a_pdf_is_ever_served_inline(self) -> None:
        self.fake.content_type = "text/html; charset=utf-8"

        self.fake.disposition = 'attachment; filename="rapport.html"'

        response = self.client.get(CONTENT, params={"disposition": "inline"})

        self.assertTrue(response.headers["content-disposition"].startswith("attachment;"))
        self.assertNotIn("x-frame-options", response.headers)
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")

    def test_a_file_name_cannot_break_out_of_the_header(self) -> None:
        # A flow name is user text; an encoded name can decode to quotes and line breaks.
        self.fake.disposition = "attachment; filename*=UTF-8''a%22%0D%0ASet-Cookie%3A%20x%3D1%5C..%5C%2Fb.pdf"

        response = self.client.get(CONTENT)

        disposition = response.headers["content-disposition"]
        self.assertTrue(disposition.startswith('attachment; filename="a Set-Cookie: x=1 .. b.pdf"'))
        self.assertNotIn("\r", disposition)
        self.assertNotIn("\n", disposition)
        self.assertNotIn("set-cookie", response.headers)

    def test_a_fullwidth_quote_cannot_close_the_ascii_fallback(self) -> None:
        # NFKD turns U+FF02 into '"'; the fallback is quoted, so it must not end early.
        self.fake.disposition = "attachment; filename*=UTF-8''m%C3%B6te%EF%BC%82%3B%20filename%3D%EF%BC%82annat.pdf"

        response = self.client.get(CONTENT)

        disposition = response.headers["content-disposition"]
        self.assertTrue(disposition.startswith('attachment; filename="mote ; filename= annat.pdf"; filename*='), disposition)
        self.assertEqual(disposition.count("filename="), 2, "the fallback's own text, and the one parameter")

    def test_eneo_refusing_the_file_passes_through(self) -> None:
        self.fake.mint_status = 410

        response = self.client.get(CONTENT)

        self.assertEqual(response.status_code, 410)
        self.assertEqual(self.fake.stream_requests, [])

    def test_the_browser_can_no_longer_mint_a_signed_url_itself(self) -> None:
        # The URL is a bearer credential for the file; only the module backend mints it now.
        response = self.client.post(
            "/api/eneo/flows/flow-1/runs/run-1/artifacts/file-1/signed-url/",
            headers={"Origin": "https://module.example.test"},
            json={"expires_in": 3600},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.fake.mint_calls, [])

    def test_the_route_rejects_dot_segments_and_needs_a_session(self) -> None:
        response = self.client.get(
            "/api/eneo/flows/flow-1/runs/%2E%2E/artifacts/file-1/content"
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.fake.mint_calls, [])

        # A decoded "?" or "#" would move the rest of the mint path into a query.
        for run_id in ("run%3F1", "run%231"):
            response = self.client.get(f"/api/eneo/flows/flow-1/runs/{run_id}/artifacts/file-1/content")
            self.assertEqual(response.status_code, 403, run_id)
        self.assertEqual(self.fake.mint_calls, [])

        anonymous = TestClient(main.app)
        self.assertEqual(anonymous.get(CONTENT).status_code, 401)
