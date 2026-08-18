import os
import unittest
from urllib.parse import parse_qs, urlparse

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "https://module.example.test")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402


class FakeResponse:
    def __init__(self, status_code: int = 200) -> None:
        self.status_code = status_code

    def json(self):
        return {
            "access_token": "module-user-token",
            "token_type": "bearer",
            "expires_in": 900,
            "module_key": "speech-to-text",
            "tenant_id": "tenant-id",
            "user": {
                "id": "user-id",
                "email": "user@example.test",
                "username": "Test User",
            },
        }


class FakeExchangeClient:
    def __init__(self, response: FakeResponse | None = None) -> None:
        self.response = response or FakeResponse()
        self.calls: list[dict[str, object]] = []

    async def post(self, url: str, **kwargs):
        self.calls.append({"url": url, **kwargs})
        return self.response


class ModuleAuthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_client = main.module_auth.http_client
        self.exchange_client = FakeExchangeClient()
        main.module_auth.http_client = self.exchange_client
        self.client = TestClient(main.app, follow_redirects=False)

    def tearDown(self) -> None:
        main.module_auth.http_client = self.original_client

    def start_login(self) -> tuple[str, str]:
        response = self.client.get("/api/auth/login")

        self.assertEqual(response.status_code, 303)
        location = response.headers["location"]
        query = parse_qs(urlparse(location).query)
        self.assertEqual(query["module_key"], ["speech-to-text"])
        self.assertEqual(
            query["redirect_uri"],
            ["https://module.example.test/api/auth/callback"],
        )
        self.assertIn("eneo_module_login_state", response.cookies)
        return query["state"][0], location

    def test_login_redirect_binds_state_to_callback_cookie(self) -> None:
        state, location = self.start_login()

        self.assertIn(f"state={state}", location)
        self.assertEqual(self.exchange_client.calls, [])

    def test_callback_exchanges_ticket_and_establishes_module_session(self) -> None:
        state, _ = self.start_login()

        callback = self.client.get(
            "/api/auth/callback",
            params={"ticket": "one-time-ticket", "state": state},
        )

        self.assertEqual(callback.status_code, 303)
        self.assertEqual(callback.headers["location"], "/flows")
        self.assertEqual(callback.headers["referrer-policy"], "no-referrer")
        self.assertIn("eneo_module_session", callback.cookies)
        self.assertEqual(len(self.exchange_client.calls), 1)
        exchange = self.exchange_client.calls[0]
        self.assertEqual(
            exchange["url"],
            "https://eneo.example.test/api/v1/module-auth/token/",
        )
        self.assertEqual(exchange["headers"], {"X-API-Key": "test-key"})
        self.assertEqual(exchange["json"], {"ticket": "one-time-ticket"})

        status = self.client.get("/api/auth/status")
        self.assertEqual(status.headers["cache-control"], "no-store")
        self.assertEqual(
            status.json(),
            {
                "authenticated": True,
                "user": {
                    "id": "user-id",
                    "email": "user@example.test",
                    "username": "Test User",
                },
            },
        )

    def test_callback_rejects_mismatched_state_without_exchange(self) -> None:
        self.start_login()

        callback = self.client.get(
            "/api/auth/callback",
            params={"ticket": "one-time-ticket", "state": "wrong-state"},
        )

        self.assertEqual(callback.status_code, 303)
        self.assertEqual(callback.headers["location"], "/?auth_error=invalid_state")
        self.assertEqual(self.exchange_client.calls, [])

    def test_callback_state_is_consumed_after_success(self) -> None:
        state, _ = self.start_login()
        first = self.client.get(
            "/api/auth/callback",
            params={"ticket": "one-time-ticket", "state": state},
        )
        second = self.client.get(
            "/api/auth/callback",
            params={"ticket": "replayed-ticket", "state": state},
        )

        self.assertEqual(first.headers["location"], "/flows")
        self.assertEqual(second.headers["location"], "/?auth_error=invalid_state")
        self.assertEqual(len(self.exchange_client.calls), 1)

    def test_failed_exchange_redirects_without_creating_session(self) -> None:
        self.exchange_client.response = FakeResponse(status_code=401)
        state, _ = self.start_login()

        callback = self.client.get(
            "/api/auth/callback",
            params={"ticket": "bad-ticket", "state": state},
        )

        self.assertEqual(callback.headers["location"], "/?auth_error=exchange_failed")
        self.assertNotIn("eneo_module_session", callback.cookies)
        self.assertEqual(
            self.client.get("/api/auth/status").json(),
            {"authenticated": False, "user": None},
        )

    def test_protected_endpoint_rejects_missing_session(self) -> None:
        response = self.client.get("/api/config")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.headers["x-auth-required"], "session")

    def test_logout_rejects_cross_origin_request(self) -> None:
        response = self.client.post(
            "/api/auth/logout",
            headers={"Origin": "https://attacker.example.test"},
        )

        self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
