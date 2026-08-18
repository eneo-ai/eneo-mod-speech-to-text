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

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.module_auth import ModuleSession, ModuleUser, SESSION_COOKIE  # noqa: E402


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
        session = ModuleSession(
            access_token="module-user-token",
            expires_at=int(time.time()) + 60,
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

    def test_mutation_rejects_cross_origin_request_before_proxying(self) -> None:
        response = self.client.post(
            "/api/eneo/flows/flow-id/runs/",
            headers={"Origin": "https://attacker.example.test"},
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_proxy_rejects_resource_outside_module_allowlist(self) -> None:
        response = self.client.post(
            "/api/eneo/users/",
            headers={"Origin": "https://module.example.test"},
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])


if __name__ == "__main__":
    unittest.main()
