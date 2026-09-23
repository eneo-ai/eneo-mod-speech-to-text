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

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.module_auth import (  # noqa: E402
    AccessCodeSession,
    EneoSsoSession,
    ModuleUser,
    SESSION_COOKIE,
)


class FakeResponse:
    content = b'{"items":[]}'
    status_code = 200
    headers = {"content-type": "application/json"}


class FakeProxyClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def request(self, **kwargs):
        self.calls.append(kwargs)
        return FakeResponse()


class EneoProxyAuthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_client = main.http_client
        self.proxy_client = FakeProxyClient()
        main.http_client = self.proxy_client
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
        session_id = main.module_auth.sessions.create(session)
        self.client.cookies.set(
            SESSION_COOKIE,
            session_id,
        )

    def tearDown(self) -> None:
        main.module_auth.settings.auth_mode = "eneo_sso"
        main.http_client = self.original_client

    def test_proxy_replaces_browser_credentials_with_module_credentials(self) -> None:
        response = self.client.get(
            "/api/eneo/flows/?published=true",
            headers={
                "Authorization": "Bearer browser-controlled-token",
                "X-API-Key": "browser-controlled-key",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.proxy_client.calls), 1)
        call = self.proxy_client.calls[0]
        self.assertEqual(
            call["url"],
            "https://eneo.example.test/api/v1/flows/",
        )
        self.assertEqual(call["params"]["published"], "true")
        self.assertEqual(call["headers"]["X-API-Key"], "test-key")
        self.assertEqual(
            call["headers"]["Authorization"],
            "Bearer module-user-token",
        )

    def test_access_code_session_uses_only_module_service_key(self) -> None:
        main.module_auth.settings.auth_mode = "access_code"
        main.module_auth.sessions.clear()
        session_id = main.module_auth.sessions.create(
            AccessCodeSession(expires_at=int(time.time()) + 60)
        )
        self.client.cookies.set(SESSION_COOKIE, session_id)

        response = self.client.get(
            "/api/eneo/flows/?published=true",
            headers={
                "Authorization": "Bearer browser-controlled-token",
                "X-API-Key": "browser-controlled-key",
            },
        )

        self.assertEqual(response.status_code, 200)
        call = self.proxy_client.calls[0]
        self.assertEqual(call["headers"]["X-API-Key"], "test-key")
        self.assertNotIn("Authorization", call["headers"])

    def test_mutation_rejects_cross_origin_request_before_proxying(self) -> None:
        response = self.client.post(
            "/api/eneo/flows/flow-id/runs/",
            headers={"Origin": "https://attacker.example.test"},
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_proxy_accepts_slash_stripped_allowlisted_path(self) -> None:
        # Next.js `next dev` strips the trailing slash from rewritten paths.
        response = self.client.get(
            "/api/eneo/flows",
            params={"space_id": "space-id"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.proxy_client.calls), 1)
        self.assertEqual(
            self.proxy_client.calls[0]["url"],
            "https://eneo.example.test/api/v1/flows/",
        )

    def test_proxy_exposes_transcript_review_routes(self) -> None:
        base = "/api/eneo/flows/flow-1/runs/run-1"
        for method, path in (
            ("GET", f"{base}/status/"),
            ("GET", f"{base}/steps/step-1/transcript-words/"),
            ("GET", f"{base}/transcript-corrections/"),
            ("PATCH", f"{base}/steps/step-1/transcript-corrections/"),
            # Eneo keeps an attempt's segments here, paged; the step result no longer embeds them.
            ("GET", f"{base}/steps/step-1/attempts/1/transcript-source/?start_segment_index=200"),
        ):
            response = self.client.request(
                method,
                path,
                headers={"Origin": "https://module.example.test"},
                json={} if method == "PATCH" else None,
            )
            self.assertEqual(response.status_code, 200, f"{method} {path}")
        self.assertEqual(len(self.proxy_client.calls), 5)

    def test_config_tells_the_flow_list_how_to_ask_eneo(self) -> None:
        original_space = main.settings.demo_space_id
        self.addCleanup(setattr, main.settings, "demo_space_id", original_space)

        # SSO: every space the user belongs to, never a named space.
        main.settings.demo_space_id = "space-demo"
        self.assertEqual(self.client.get("/api/config").json(), {"flow_list": {"space_id": None}})

        main.module_auth.settings.auth_mode = "access_code"
        main.module_auth.sessions.clear()
        self.client.cookies.set(
            SESSION_COOKIE,
            main.module_auth.sessions.create(AccessCodeSession(expires_at=int(time.time()) + 60)),
        )
        self.assertEqual(self.client.get("/api/config").json(), {"flow_list": {"space_id": "space-demo"}})

        # Access code without a configured space: the list cannot be asked for at all.
        main.settings.demo_space_id = None
        self.assertEqual(self.client.get("/api/config").json(), {"flow_list": None})
        self.assertEqual(self.proxy_client.calls, [])

    def test_proxy_forwards_flow_discovery_across_the_users_spaces(self) -> None:
        response = self.client.get("/api/eneo/flows/?published_only=true&limit=200&offset=0")

        self.assertEqual(response.status_code, 200)
        call = self.proxy_client.calls[0]
        self.assertEqual(call["url"], "https://eneo.example.test/api/v1/flows/")
        self.assertEqual(dict(call["params"]), {"published_only": "true", "limit": "200", "offset": "0"})

    def test_proxy_no_longer_exposes_spaces(self) -> None:
        # Discovery lists flows across spaces; the spaces routes refuse module credentials anyway.
        for path in ("/api/eneo/spaces/", "/api/eneo/spaces/space-1/"):
            self.assertEqual(self.client.get(path).status_code, 403, path)
        self.assertEqual(self.proxy_client.calls, [])

    def test_proxy_exposes_retry_from_the_failed_step_with_its_idempotency_key(self) -> None:
        response = self.client.post(
            "/api/eneo/flows/flow-1/runs/run-1/retry/",
            headers={
                "Origin": "https://module.example.test",
                "Idempotency-Key": "flow-run-retry:run-1",
            },
        )

        self.assertEqual(response.status_code, 200)
        call = self.proxy_client.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["url"], "https://eneo.example.test/api/v1/flows/flow-1/runs/run-1/retry/")
        self.assertEqual(call["headers"]["idempotency-key"], "flow-run-retry:run-1")

    def test_proxy_slash_tolerance_does_not_widen_allowlist(self) -> None:
        response = self.client.get("/api/eneo/users")

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_proxy_rejects_resource_outside_module_allowlist(self) -> None:
        response = self.client.post(
            "/api/eneo/users/",
            headers={"Origin": "https://module.example.test"},
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_proxy_rejects_encoded_dot_segment_traversal(self) -> None:
        # `%2E%2E` survives ASGI path normalization and decodes to `..`, which
        # would resolve upstream to /api/v1/flows/../runs/ -> /api/v1/runs/.
        response = self.client.get("/api/eneo/flows/%2E%2E/runs/")

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_proxy_rejects_single_dot_segment(self) -> None:
        response = self.client.get("/api/eneo/flows/%2E/runs/")

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_proxy_rejects_an_encoded_query_or_fragment_in_a_segment(self) -> None:
        # `flows/x%3F/runs/` matches the allowlist but would reach
        # /api/v1/flows/x upstream, with the rest moved into the query.
        for path in ("/api/eneo/flows/x%3F/runs/", "/api/eneo/flows/x%23/runs/"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 403, path)
        response = self.client.post(
            "/api/eneo/flows/x%3F/files/",
            headers={"Origin": "https://module.example.test"},
            files={"upload_file": ("meeting.webm", b"audio", "audio/webm")},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_upload_route_rejects_dot_segment_flow_id(self) -> None:
        response = self.client.post(
            "/api/eneo/flows/%2E%2E/files/",
            headers={"Origin": "https://module.example.test"},
            files={"upload_file": ("meeting.webm", b"audio", "audio/webm")},
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])


if __name__ == "__main__":
    unittest.main()
