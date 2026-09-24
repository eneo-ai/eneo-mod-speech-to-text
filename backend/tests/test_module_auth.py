import asyncio
import itertools
import os
import re
import time
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "https://module.example.test")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("AUTH_MODE", "eneo_sso")

import httpx  # noqa: E402
from fastapi import Depends, FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.config import Settings  # noqa: E402
from app.module_auth import (  # noqa: E402
    EneoSsoSession,
    ModuleAuth,
    ModuleUser,
    SESSION_COOKIE,
    STATE_COOKIE,
)

# Eneo's session ceiling in these tests; shorter than the module's 8-hour default.
ENEO_SESSION_SECONDS = 4 * 60 * 60


def token_payload(
    access_token: str = "module-user-token",
    *,
    expires_in: int = 900,
    user_id: str = "user-id",
) -> dict[str, object]:
    """Eneo's ModuleTokenResponse, as the ticket exchange and refresh return it."""
    ceiling = datetime.fromtimestamp(time.time() + ENEO_SESSION_SECONDS, tz=timezone.utc)
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "expires_in": expires_in,
        "session_expires_at": ceiling.isoformat(),
        "module_key": "speech-to-text",
        "tenant_id": "tenant-id",
        "user": {
            "id": user_id,
            "email": "user@example.test",
            "username": "Test User",
        },
    }


class FakeResponse:
    def __init__(self, status_code: int = 200, *, user_id: str = "user-id") -> None:
        self.status_code = status_code
        self.user_id = user_id

    def json(self):
        return token_payload(user_id=self.user_id)


class FakeExchangeClient:
    def __init__(self, response: FakeResponse | None = None) -> None:
        self.response = response or FakeResponse()
        self.validation_response = FakeResponse()
        self.calls: list[dict[str, object]] = []

    async def post(self, url: str, **kwargs):
        self.calls.append({"method": "POST", "url": url, **kwargs})
        return self.response

    async def get(self, url: str, **kwargs):
        self.calls.append({"method": "GET", "url": url, **kwargs})
        return self.validation_response


class ModuleAuthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_client = main.module_auth.http_client
        self.exchange_client = FakeExchangeClient()
        main.module_auth.http_client = self.exchange_client
        main.module_auth.sessions.clear()
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
        self.assertNotIn(
            "module-user-token",
            callback.cookies[SESSION_COOKIE],
        )
        self.assertEqual(len(self.exchange_client.calls), 2)
        exchange = self.exchange_client.calls[0]
        self.assertEqual(
            exchange["url"],
            "https://eneo.example.test/api/v1/module-auth/token/",
        )
        self.assertEqual(exchange["headers"], {"X-API-Key": "test-key"})
        self.assertEqual(exchange["json"], {"ticket": "one-time-ticket"})
        validation = self.exchange_client.calls[1]
        self.assertEqual(validation["method"], "GET")
        self.assertEqual(
            validation["url"],
            "https://eneo.example.test/api/v1/module-auth/speech-to-text/session/",
        )
        self.assertEqual(
            validation["headers"],
            {
                "X-API-Key": "test-key",
                "Authorization": "Bearer module-user-token",
            },
        )

        status = self.client.get("/api/auth/status")
        self.assertEqual(status.headers["cache-control"], "no-store")
        body = status.json()
        # The page checks again once the 900-second token is half used.
        self.assertTrue(0 < body.pop("refresh_in") <= 450)
        self.assertTrue(0 < body.pop("session_ends_in") <= ENEO_SESSION_SECONDS)
        self.assertEqual(
            body,
            {
                "authenticated": True,
                "auth_mode": "eneo_sso",
                "user": {
                    "id": "user-id",
                    "email": "user@example.test",
                    "username": "Test User",
                },
            },
        )

    def test_callback_session_outlives_the_module_token(self) -> None:
        state, _ = self.start_login()
        before = int(time.time())

        callback = self.client.get(
            "/api/auth/callback",
            params={"ticket": "one-time-ticket", "state": state},
        )

        after = int(time.time())
        session_cookie = next(
            header
            for header in callback.headers.get_list("set-cookie")
            if header.startswith(f"{SESSION_COOKIE}=")
        )
        max_age = int(re.search(r"Max-Age=(\d+)", session_cookie).group(1))
        # Eneo's 4-hour ceiling caps the module's 8-hour default, not the
        # 15-minute token: refresh keeps the session going until then.
        self.assertTrue(
            ENEO_SESSION_SECONDS - (after - before) - 1
            <= max_age
            <= ENEO_SESSION_SECONDS
        )
        session = main.module_auth.sessions.get(callback.cookies[SESSION_COOKIE])
        self.assertTrue(before + 900 <= session.expires_at <= after + 900)
        self.assertTrue(before + 450 <= session.refresh_at <= after + 450)

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
        self.assertEqual(len(self.exchange_client.calls), 2)

    def test_status_says_when_the_session_ends(self) -> None:
        state, _ = self.start_login()
        self.client.get("/api/auth/callback", params={"ticket": "one-time-ticket", "state": state})

        body = self.client.get("/api/auth/status").json()

        # Eneo's 4-hour ceiling, not the 15-minute token: the page warns before it.
        self.assertTrue(ENEO_SESSION_SECONDS - 5 <= body["session_ends_in"] <= ENEO_SESSION_SECONDS)

    def test_a_login_can_return_to_a_page_of_the_module(self) -> None:
        response = self.client.get("/api/auth/login", params={"next": "/inloggad"})
        state = parse_qs(urlparse(response.headers["location"]).query)["state"][0]

        callback = self.client.get(
            "/api/auth/callback",
            params={"ticket": "one-time-ticket", "state": state},
        )

        self.assertEqual(callback.headers["location"], "/inloggad")

    def test_a_login_never_returns_outside_the_module(self) -> None:
        for unsafe in ("https://evil.example", "//evil.example", "/\\evil.example", "inloggad"):
            with self.subTest(next=unsafe):
                response = self.client.get("/api/auth/login", params={"next": unsafe})
                state = parse_qs(urlparse(response.headers["location"]).query)["state"][0]

                callback = self.client.get(
                    "/api/auth/callback",
                    params={"ticket": "one-time-ticket", "state": state},
                )

                self.assertEqual(callback.headers["location"], "/flows")

    def sign_in(self) -> str:
        state, _ = self.start_login()
        callback = self.client.get("/api/auth/callback", params={"ticket": "first", "state": state})
        return callback.cookies[SESSION_COOKIE]

    def start_renewal(self) -> str:
        response = self.client.get("/api/auth/login", params={"renew": "1", "next": "/inloggad"})
        return parse_qs(urlparse(response.headers["location"]).query)["state"][0]

    def test_a_renewal_by_the_same_user_replaces_the_session(self) -> None:
        first = self.sign_in()
        state = self.start_renewal()

        callback = self.client.get("/api/auth/callback", params={"ticket": "again", "state": state})

        self.assertEqual(callback.headers["location"], "/inloggad")
        self.assertNotEqual(callback.cookies[SESSION_COOKIE], first)

    def test_a_renewal_by_another_user_keeps_the_page_s_session(self) -> None:
        first = self.sign_in()
        state = self.start_renewal()
        self.exchange_client.response = FakeResponse(user_id="someone-else")
        self.exchange_client.validation_response = FakeResponse(user_id="someone-else")

        callback = self.client.get("/api/auth/callback", params={"ticket": "other-user", "state": state})

        self.assertEqual(callback.headers["location"], "/inloggad?fel=annan-anvandare")
        self.assertNotIn(SESSION_COOKIE, callback.cookies)
        self.assertEqual(self.client.cookies.get(SESSION_COOKIE), first)
        self.assertEqual(self.client.get("/api/auth/status").json()["user"]["id"], "user-id")

    def test_a_renewal_without_a_live_session_is_refused_and_signs_no_one_in(self) -> None:
        self.sign_in()
        ended = time.time() + ENEO_SESSION_SECONDS + 60
        for case, cookies in (("the session has ended", None), ("no session at all", {})):
            with self.subTest(case), patch("app.module_auth.time.time", return_value=ended):
                if cookies is not None:
                    self.client.cookies.clear()
                response = self.client.get("/api/auth/login", params={"renew": "1", "next": "/inloggad"})

                # No handoff to Eneo: with no user to bind to, anyone could sign in under this page.
                self.assertEqual(response.status_code, 303)
                self.assertEqual(response.headers["location"], "/inloggad?fel=utgangen")
                self.assertNotIn(STATE_COOKIE, response.cookies)
                self.assertNotIn(SESSION_COOKIE, response.cookies)

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
            {
                "authenticated": False,
                "auth_mode": "eneo_sso",
                "user": None,
            },
        )

    def test_failed_dual_auth_validation_does_not_create_session(self) -> None:
        self.exchange_client.validation_response = FakeResponse(status_code=403)
        state, _ = self.start_login()

        callback = self.client.get(
            "/api/auth/callback",
            params={"ticket": "one-time-ticket", "state": state},
        )

        self.assertEqual(callback.headers["location"], "/?auth_error=validation_failed")
        self.assertNotIn(SESSION_COOKIE, callback.cookies)
        self.assertEqual(len(self.exchange_client.calls), 2)

    def test_protected_endpoint_rejects_missing_session(self) -> None:
        response = self.client.get("/api/config")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.headers["x-auth-required"], "session")

    def test_access_code_login_is_not_available_in_sso_mode(self) -> None:
        response = self.client.post(
            "/api/auth/login",
            json={"access_code": "test-code"},
            headers={"Origin": "https://module.example.test"},
        )

        self.assertEqual(response.status_code, 404)
        self.assertNotIn(SESSION_COOKIE, response.cookies)

    def test_logout_rejects_cross_origin_request(self) -> None:
        response = self.client.post(
            "/api/auth/logout",
            headers={"Origin": "https://attacker.example.test"},
        )

        self.assertEqual(response.status_code, 403)

    def test_logout_revokes_the_opaque_session(self) -> None:
        state, _ = self.start_login()
        callback = self.client.get(
            "/api/auth/callback",
            params={"ticket": "one-time-ticket", "state": state},
        )
        session_id = callback.cookies[SESSION_COOKIE]

        response = self.client.post(
            "/api/auth/logout",
            headers={"Origin": "https://module.example.test"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(main.module_auth.sessions.get(session_id))
        self.assertEqual(
            self.client.get("/api/auth/status").json(),
            {
                "authenticated": False,
                "auth_mode": "eneo_sso",
                "user": None,
            },
        )


class FakeEneo:
    """Eneo's token refresh route plus any proxied resource call."""

    def __init__(self, refresh) -> None:
        # A response, an exception to raise, or an async function answering the call.
        self.refresh = refresh
        self.refresh_calls: list[dict[str, object]] = []
        self.proxied: list[dict[str, object]] = []

    async def post(self, url: str, **kwargs):
        self.refresh_calls.append({"url": url, **kwargs})
        if isinstance(self.refresh, Exception):
            raise self.refresh
        if callable(self.refresh):
            return await self.refresh(**kwargs)
        return self.refresh

    async def request(self, **kwargs):
        self.proxied.append(kwargs)
        return httpx.Response(200, json={"items": []})


class FakeClock:
    """Stands in for the time module inside app.module_auth."""

    def __init__(self) -> None:
        self.now = time.time()

    def time(self) -> float:
        return self.now


class TokenRefreshFixture:
    """Sessions whose module token is due for renewal, and a fake Eneo."""

    def setUp(self) -> None:
        self.original_auth_client = main.module_auth.http_client
        self.original_proxy_client = main.http_client
        main.module_auth.sessions.clear()
        self.client = TestClient(main.app)

    def tearDown(self) -> None:
        main.module_auth.http_client = self.original_auth_client
        main.http_client = self.original_proxy_client

    def sign_in_with_due_token(
        self, token: str = "module-user-token", *, expires_in: int = 100
    ) -> str:
        """A session past its token's half-life, the token itself still valid."""
        now = int(time.time())
        session_id = main.module_auth.sessions.create(
            EneoSsoSession(
                access_token=token,
                expires_at=now + expires_in,
                refresh_at=now - 1,
                session_expires_at=now + 3600,
                module_key="speech-to-text",
                tenant_id="tenant-id",
                user=ModuleUser(id="user-id", email="user@example.test"),
            )
        )
        self.client.cookies.set(SESSION_COOKIE, session_id)
        return session_id

    def use_eneo(self, refresh) -> FakeEneo:
        eneo = FakeEneo(refresh)
        main.module_auth.http_client = eneo
        main.http_client = eneo
        return eneo


class ModuleTokenRefreshTests(TokenRefreshFixture, unittest.TestCase):

    def test_due_token_is_refreshed_before_the_request_is_proxied(self) -> None:
        session_id = self.sign_in_with_due_token()
        eneo = self.use_eneo(
            httpx.Response(200, json=token_payload("refreshed-token", expires_in=900))
        )
        before = int(time.time())

        response = self.client.get("/api/eneo/flows/")

        after = int(time.time())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(eneo.refresh_calls), 1)
        refresh = eneo.refresh_calls[0]
        self.assertEqual(
            refresh["url"],
            "https://eneo.example.test/api/v1/module-auth/speech-to-text/token/refresh/",
        )
        self.assertEqual(
            refresh["headers"],
            {"X-API-Key": "test-key", "Authorization": "Bearer module-user-token"},
        )
        self.assertEqual(
            eneo.proxied[0]["headers"]["Authorization"], "Bearer refreshed-token"
        )
        session = main.module_auth.sessions.get(session_id)
        self.assertEqual(session.access_token, "refreshed-token")
        self.assertTrue(before + 900 <= session.expires_at <= after + 900)
        self.assertTrue(before + 450 <= session.refresh_at <= after + 450)

        # The renewed token is not due, so the next request goes straight through.
        self.client.get("/api/eneo/flows/")
        self.assertEqual(len(eneo.refresh_calls), 1)
        self.assertEqual(
            eneo.proxied[1]["headers"]["Authorization"], "Bearer refreshed-token"
        )

    def test_refused_refresh_ends_the_session(self) -> None:
        refusals = {
            "expired or past the ceiling": httpx.Response(401),
            "key no longer bound": httpx.Response(403),
            "module removed": httpx.Response(404),
            "another user's token": httpx.Response(
                200, json=token_payload("other-token", user_id="other-user")
            ),
        }
        for reason, refresh in refusals.items():
            with self.subTest(reason):
                session_id = self.sign_in_with_due_token()
                eneo = self.use_eneo(refresh)

                response = self.client.get("/api/eneo/flows/")

                self.assertEqual(response.status_code, 401)
                self.assertEqual(response.headers["x-auth-required"], "session")
                self.assertEqual(eneo.proxied, [])
                self.assertIsNone(main.module_auth.sessions.get(session_id))
                self.assertFalse(
                    self.client.get("/api/auth/status").json()["authenticated"]
                )

    def test_unavailable_eneo_keeps_the_still_valid_token(self) -> None:
        for refresh in (httpx.Response(503), httpx.ConnectError("unreachable")):
            with self.subTest(refresh=refresh):
                session_id = self.sign_in_with_due_token()
                eneo = self.use_eneo(refresh)

                response = self.client.get("/api/eneo/flows/")

                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    eneo.proxied[0]["headers"]["Authorization"],
                    "Bearer module-user-token",
                )
                self.assertIsNotNone(main.module_auth.sessions.get(session_id))

    def test_status_check_refreshes_an_idle_session(self) -> None:
        # The browser polls the status while it records, which sends no other request.
        session_id = self.sign_in_with_due_token()
        eneo = self.use_eneo(
            httpx.Response(200, json=token_payload("refreshed-token", expires_in=900))
        )

        status = self.client.get("/api/auth/status")

        self.assertTrue(status.json()["authenticated"])
        self.assertEqual(len(eneo.refresh_calls), 1)
        self.assertEqual(
            main.module_auth.sessions.get(session_id).access_token, "refreshed-token"
        )

    def test_renewal_that_outlasts_the_token_ends_the_session(self) -> None:
        clock = FakeClock()

        async def refresh(**_):
            clock.now += 6  # Eneo answers only after the token has expired.
            return httpx.Response(503)

        with patch("app.module_auth.time", clock):
            session_id = self.sign_in_with_due_token(expires_in=5)
            eneo = self.use_eneo(refresh)

            response = self.client.get("/api/eneo/flows/")

            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.headers["x-auth-required"], "session")
            self.assertEqual(eneo.proxied, [])
            self.assertIsNone(main.module_auth.sessions.get(session_id))

    def test_one_minute_token_is_kept_alive_on_the_status_schedule(self) -> None:
        # Eneo accepts MODULE_AUTH_TOKEN_EXPIRY_MINUTES=1. The page asks for the
        # status again `refresh_in` seconds after each answer.
        clock = FakeClock()
        renewals = itertools.count(1)

        async def refresh(**_):
            token = f"token-{next(renewals)}"
            return httpx.Response(200, json=token_payload(token, expires_in=60))

        with patch("app.module_auth.time", clock):
            now = int(clock.now)
            session_id = main.module_auth.sessions.create(
                EneoSsoSession(
                    access_token="token-0",
                    expires_at=now + 60,
                    refresh_at=now + 30,
                    session_expires_at=now + 3600,
                    module_key="speech-to-text",
                    tenant_id="tenant-id",
                    user=ModuleUser(id="user-id", email="user@example.test"),
                )
            )
            self.client.cookies.set(SESSION_COOKIE, session_id)
            eneo = self.use_eneo(refresh)

            status = self.client.get("/api/auth/status").json()
            for _ in range(4):  # four minutes on a one-minute token
                clock.now += status["refresh_in"] + 1
                status = self.client.get("/api/auth/status").json()
                self.assertTrue(status["authenticated"])

        self.assertEqual(len(eneo.refresh_calls), 4)


class ConcurrentTokenRefreshTests(TokenRefreshFixture, unittest.IsolatedAsyncioTestCase):
    async def get_flows(self, session_id: str) -> httpx.Response:
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://module.test"
        ) as client:
            return await client.get(
                "/api/eneo/flows/",
                headers={"Cookie": f"{SESSION_COOKIE}={session_id}"},
            )

    async def test_a_stalled_renewal_does_not_hold_up_another_session(self) -> None:
        stalled = self.sign_in_with_due_token("stalled-token")
        other = self.sign_in_with_due_token("other-token")
        started, release = asyncio.Event(), asyncio.Event()

        async def refresh(headers, **_):
            token = headers["Authorization"].removeprefix("Bearer ")
            if token == "stalled-token":
                started.set()
                await release.wait()
            return httpx.Response(200, json=token_payload(f"renewed-{token}"))

        eneo = self.use_eneo(refresh)
        waiting = asyncio.create_task(self.get_flows(stalled))
        await started.wait()

        response = await asyncio.wait_for(self.get_flows(other), timeout=2)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            eneo.proxied[-1]["headers"]["Authorization"], "Bearer renewed-other-token"
        )
        release.set()
        self.assertEqual((await waiting).status_code, 200)

    async def test_concurrent_requests_share_one_failed_renewal(self) -> None:
        session_id = self.sign_in_with_due_token()

        async def refresh(**_):
            await asyncio.sleep(0.05)  # still in flight while the others arrive
            return httpx.Response(503)

        eneo = self.use_eneo(refresh)

        responses = await asyncio.gather(
            *(self.get_flows(session_id) for _ in range(8))
        )

        self.assertEqual([r.status_code for r in responses], [200] * 8)
        self.assertEqual(len(eneo.refresh_calls), 1)
        self.assertEqual(
            {call["headers"]["Authorization"] for call in eneo.proxied},
            {"Bearer module-user-token"},
        )
        # Eneo just failed to answer, so the next request does not ask again yet.
        await self.get_flows(session_id)
        self.assertEqual(len(eneo.refresh_calls), 1)
        # Nothing outlives the refresh that it coordinated.
        self.assertEqual(main.module_auth._refreshes, {})


class AccessCodeAuthTests(unittest.TestCase):
    def setUp(self) -> None:
        settings = Settings(
            eneo_backend_url="https://eneo.example.test",
            eneo_public_url=None,
            module_public_url="https://module.example.test",
            module_key="speech-to-text",
            eneo_api_key="test-key",
            session_secret="x" * 48,
            auth_mode="access_code",
            app_access_code="test-access-code-1234",
            cookie_secure=True,
            session_max_age_seconds=90 * 60,
        )
        self.module_auth = ModuleAuth(
            settings=settings,
            http_client=FakeExchangeClient(),
        )
        app = FastAPI()
        app.include_router(self.module_auth.router, prefix="/api/auth")

        @app.get(
            "/protected",
            dependencies=[Depends(self.module_auth.require_session)],
        )
        async def protected() -> dict[str, bool]:
            return {"ok": True}

        self.client = TestClient(
            app,
            base_url="https://module.example.test",
            follow_redirects=False,
        )

    def login(self, access_code: str = "test-access-code-1234"):
        return self.client.post(
            "/api/auth/login",
            json={"access_code": access_code},
            headers={"Origin": "https://module.example.test"},
        )

    def test_correct_code_creates_opaque_session_and_exposes_mode(self) -> None:
        response = self.login()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True})
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertIn(SESSION_COOKIE, response.cookies)
        self.assertNotIn("test-access-code-1234", response.cookies[SESSION_COOKIE])
        self.assertIn("HttpOnly", response.headers["set-cookie"])
        self.assertIn("Secure", response.headers["set-cookie"])
        self.assertIn("SameSite=lax", response.headers["set-cookie"])
        self.assertIn("Max-Age=5400", response.headers["set-cookie"])
        self.assertEqual(self.client.get("/protected").status_code, 200)
        status = self.client.get("/api/auth/status").json()
        self.assertTrue(0 < status.pop("session_ends_in") <= 90 * 60)
        self.assertEqual(
            status,
            {
                "authenticated": True,
                "auth_mode": "access_code",
                "user": None,
            },
        )

    def test_status_says_when_the_access_code_session_ends(self) -> None:
        self.login()

        body = self.client.get("/api/auth/status").json()

        self.assertTrue(90 * 60 - 5 <= body["session_ends_in"] <= 90 * 60)

    def test_wrong_code_returns_generic_unauthorized_without_session(self) -> None:
        response = self.login("wrong-code")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"detail": "Invalid access code"})
        self.assertNotIn(SESSION_COOKIE, response.cookies)
        self.assertEqual(self.client.get("/protected").status_code, 401)

    def test_login_rejects_cross_origin_request_before_checking_code(self) -> None:
        response = self.client.post(
            "/api/auth/login",
            json={"access_code": "test-access-code-1234"},
            headers={"Origin": "https://attacker.example.test"},
        )

        self.assertEqual(response.status_code, 403)
        self.assertNotIn(SESSION_COOKIE, response.cookies)

    def test_sso_routes_are_not_available_in_access_code_mode(self) -> None:
        login = self.client.get("/api/auth/login")
        callback = self.client.get(
            "/api/auth/callback",
            params={"ticket": "ticket", "state": "state"},
        )

        self.assertEqual(login.status_code, 404)
        self.assertEqual(callback.status_code, 404)

    def test_logout_revokes_access_code_session(self) -> None:
        login = self.login()
        session_id = login.cookies[SESSION_COOKIE]

        response = self.client.post(
            "/api/auth/logout",
            headers={"Origin": "https://module.example.test"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(self.module_auth.sessions.get(session_id))
        self.assertEqual(
            self.client.get("/api/auth/status").json(),
            {
                "authenticated": False,
                "auth_mode": "access_code",
                "user": None,
            },
        )


if __name__ == "__main__":
    unittest.main()
