"""The login's end, as Eneo says it: which of Eneo's refusals end the module's session, and only once Eneo confirms it.

Eneo answers a call made with a token it has revoked (a changed password, "log out everywhere") with 401 and the code
authentication_error. So does a route of Eneo's that takes no module tokens, for a valid one, and so the session ends
only when Eneo's own session route refuses the same token. Every other refusal (the module's key, a 403, another 401
code) is Eneo's answer to show, and the session stays. The bodies below are Eneo's own, as its exception handlers write
them.
"""

import asyncio
import os
import time
import unittest
from unittest.mock import patch

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "http://localhost:3002")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")

import httpx  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from starlette.requests import Request  # noqa: E402

from app import main, module_auth  # noqa: E402
from app.module_auth import EneoSsoSession, ModuleAuth, ModuleUser, refuses_the_login  # noqa: E402
from app.upstream import SMALL_ANSWER  # noqa: E402

# Eneo's answers, field for field.
# A token Eneo no longer takes (revoked, expired, another tenant's, its user gone): AuthenticationException's handler.
REVOKED = {"message": "Unauthenticated", "eneo_error_code": 9005, "code": "authentication_error", "request_id": "request-1"}
# The module's key, revoked: the key's own handler, with a copy of its detail.
KEY_REVOKED = {
    "code": "invalid_api_key",
    "message": "API key is revoked.",
    "context": {"auth_layer": "identity"},
    "request_id": "request-1",
    "eneo_error_code": 9005,
    "detail": {"code": "invalid_api_key", "message": "API key is revoked.", "context": {"auth_layer": "identity"}, "request_id": "request-1"},
}
NOT_REGISTERED = {
    "message": "API key is not registered for this module.",
    "eneo_error_code": 9001,
    "code": "forbidden",
    "context": {"auth_layer": "domain_policy"},
    "request_id": "request-1",
}
INACTIVE = {"message": "Forbidden: you do not have permission to perform this action.", "eneo_error_code": 9019, "code": "user_inactive", "request_id": "request-1"}
SUSPENDED = {"message": "Tenant is suspended", "eneo_error_code": 9025, "code": "tenant_suspended", "request_id": "request-1"}
NOT_SCOPED = {"code": "insufficient_scope", "message": "API key is not scoped to this space.", "context": {"auth_layer": "api_key_scope"}, "eneo_error_code": 9001}
SERVICE_KEY_ONLY = {
    "message": "This Flows endpoint requires a user principal. Service-key principals cannot use this action.",
    "eneo_error_code": 9001,
    "code": "service_key_principal_not_supported",
    "context": {"auth_layer": "service_key_principal"},
}
# A refusal Eneo may add for a step-up of the sign-in: it asks for more of the same login, it does not end it.
STEP_UP = {"message": "Step-up authentication is required.", "eneo_error_code": 9005, "code": "step_up_required"}

SESSION_ROUTE = "https://eneo.example.test/api/v1/module-auth/speech-to-text/session/"
SESSION_ROUTE_ACCEPTS = httpx.Response(
    200, json={"module_key": "speech-to-text", "tenant_id": "tenant-id", "user": {"id": "user-id", "email": "user@example.test"}}
)


def a_session(token: str = "module-user-token") -> EneoSsoSession:
    now = int(time.time())
    return EneoSsoSession(
        access_token=token,
        expires_at=now + 600,
        refresh_at=now + 300,
        session_expires_at=now + 3600,
        module_key="speech-to-text",
        tenant_id="tenant-id",
        user=ModuleUser(id="user-id", email="user@example.test"),
    )


class SessionRoute:
    """Eneo's session route as the module's client sees it: every check gets ``answer`` (a response, an exception to
    raise, or an async function that answers), and is counted."""

    def __init__(self, answer=SESSION_ROUTE_ACCEPTS) -> None:
        self.answer = answer
        self.calls: list[dict[str, object]] = []

    async def get(self, url: str, **kwargs):
        self.calls.append({"url": url, **kwargs})
        if isinstance(self.answer, BaseException):
            raise self.answer
        if callable(self.answer):
            return await self.answer()
        return self.answer


class RefusalTests(unittest.TestCase):
    def test_only_a_401_with_the_code_authentication_error_at_the_top_may_end_the_login(self) -> None:
        cases = {
            "a revoked token": (httpx.Response(401, json=REVOKED), True),
            "the same without a request id": (httpx.Response(401, json={k: v for k, v in REVOKED.items() if k != "request_id"}), True),
            "the module's key revoked": (httpx.Response(401, json=KEY_REVOKED), False),
            "the key not registered for the module": (httpx.Response(403, json=NOT_REGISTERED), False),
            "the user inactive": (httpx.Response(403, json=INACTIVE), False),
            "the tenant suspended": (httpx.Response(403, json=SUSPENDED), False),
            "the key not scoped": (httpx.Response(403, json=NOT_SCOPED), False),
            "a service key without a user": (httpx.Response(403, json=SERVICE_KEY_ONLY), False),
            "the code on a 403": (httpx.Response(403, json=REVOKED), False),
            "the code on a 200": (httpx.Response(200, json=REVOKED), False),
            "another 401 code (a step-up)": (httpx.Response(401, json=STEP_UP), False),
            "an unknown 401 code": (httpx.Response(401, json={"code": "something_new", "message": "?"}), False),
            "a 401 without JSON": (httpx.Response(401, text="<html>Unauthorized</html>"), False),
            "a 401 without a body": (httpx.Response(401), False),
            "a 401 whose JSON has no code": (httpx.Response(401, json={"detail": "a module-user token that this stub gave is required"}), False),
            "the code only inside detail": (httpx.Response(401, json={"detail": {"code": "authentication_error"}}), False),
            "a code that is not a string": (httpx.Response(401, json={"code": ["authentication_error"]}), False),
            "a JSON list": (httpx.Response(401, json=[REVOKED]), False),
            "bytes that are not UTF-8": (httpx.Response(401, content=b"\xff\xfe"), False),
        }
        for case, (answer, ends) in cases.items():
            with self.subTest(case):
                self.assertIs(refuses_the_login(answer), ends)


class LoginEndCase(unittest.IsolatedAsyncioTestCase):
    """A ModuleAuth of its own, in front of a fake session route, and requests admitted the way the routes admit them."""

    def setUp(self) -> None:
        self.route = SessionRoute()
        self.auth = ModuleAuth(settings=main.settings, http_client=self.route)
        self.session_id = self.auth.sessions.create(a_session())

    async def admitted(self, session_id: str | None = None) -> Request:
        request = Request({"type": "http", "method": "GET", "path": "/api/eneo/flows/", "headers": []})
        await self.auth.require_session(request, session_id or self.session_id)
        return request

    def renew(self, token: str) -> None:
        """The refresh: a new token under the same session id."""
        self.auth.sessions.replace(self.session_id, a_session(token))

    def held_token(self) -> str | None:
        session = self.auth.sessions.get(self.session_id)
        return session.access_token if session else None


class ConfirmationTests(LoginEndCase):
    async def test_a_refusal_the_session_route_confirms_ends_the_session(self) -> None:
        self.route.answer = httpx.Response(401, json=REVOKED)
        request = await self.admitted()

        ended = await self.auth.login_refused(request, httpx.Response(401, json=REVOKED))

        self.assertTrue(ended)
        self.assertIsNone(self.auth.sessions.get(self.session_id))
        self.assertEqual(len(self.route.calls), 1)
        check = self.route.calls[0]
        self.assertEqual(check["url"], SESSION_ROUTE)
        self.assertEqual(check["headers"], {"X-API-Key": "test-key", "Authorization": "Bearer module-user-token"}, "the token that was refused")
        self.assertEqual(check["extensions"], SMALL_ANSWER)

    async def test_a_token_the_session_route_accepts_keeps_the_session(self) -> None:
        # A route of Eneo's that takes no module tokens refuses a valid one: a new login would not change that.
        request = await self.admitted()

        ended = await self.auth.login_refused(request, httpx.Response(401, json=REVOKED))

        self.assertFalse(ended)
        self.assertEqual(self.held_token(), "module-user-token")
        self.assertEqual(len(self.route.calls), 1)
        # And each refusal like it is checked once, never in a loop.
        await self.auth.login_refused(request, httpx.Response(401, json=REVOKED))
        self.assertEqual(len(self.route.calls), 2)

    async def test_no_confirmation_keeps_the_session(self) -> None:
        async def never():
            await asyncio.Event().wait()

        answers = {
            "another 401 code": httpx.Response(401, json=KEY_REVOKED),
            "a 401 without the code": httpx.Response(401, json={"detail": "no"}),
            "a 403": httpx.Response(403, json=NOT_REGISTERED),
            "a 404": httpx.Response(404, json={"code": "not_found", "message": "Not found"}),
            "too many requests": httpx.Response(429, json={"code": "rate_limit_exceeded"}),
            "Eneo failing": httpx.Response(503),
            "a 200 for someone else": httpx.Response(200, json={"module_key": "speech-to-text", "tenant_id": "t", "user": {"id": "other", "email": "o@x"}}),
            "a 200 that is not JSON": httpx.Response(200, text="ok"),
            "unreachable": httpx.ConnectError("unreachable"),
            "a read timeout": httpx.ReadTimeout("slow"),
            "an answer past its bound": main.UnboundedAnswer("too long", request=httpx.Request("GET", SESSION_ROUTE)),
            "no answer before the deadline": never,
        }
        for case, answer in answers.items():
            with self.subTest(case):
                self.route.answer, self.route.calls = answer, []
                request = await self.admitted()

                with patch.object(module_auth, "SESSION_CHECK_SECONDS", 0.05):
                    ended = await self.auth.login_refused(request, httpx.Response(401, json=REVOKED))

                self.assertFalse(ended)
                self.assertEqual(self.held_token(), "module-user-token")
                self.assertEqual(len(self.route.calls), 1, "one check, not another")

    async def test_a_refusal_that_cannot_end_the_login_asks_nothing(self) -> None:
        request = await self.admitted()
        for answer in (
            httpx.Response(401, json=KEY_REVOKED),
            httpx.Response(403, json=INACTIVE),
            httpx.Response(401, json=STEP_UP),
            httpx.Response(401, json={"detail": "no code"}),
            httpx.Response(200, json={"items": []}),
        ):
            with self.subTest(status=answer.status_code, body=answer.content):
                self.assertFalse(await self.auth.login_refused(request, answer))
        self.assertEqual(self.route.calls, [])
        self.assertEqual(self.held_token(), "module-user-token")

    def test_the_session_answer_is_require_sessions(self) -> None:
        answer = module_auth.session_ended()

        self.assertIsInstance(answer, HTTPException)
        self.assertEqual((answer.status_code, answer.detail, answer.headers), (401, "Not authenticated", {"X-Auth-Required": "session"}))


class LateAndConcurrentRefusalTests(LoginEndCase):
    async def test_a_new_login_while_an_old_call_waits_keeps_the_new_session(self) -> None:
        old = await self.admitted()
        # The callback of a new login deletes the session the browser had and makes another.
        self.auth.sessions.delete(self.session_id)
        new_id = self.auth.sessions.create(a_session("new-login-token"))

        ended = await self.auth.login_refused(old, httpx.Response(401, json=REVOKED))

        self.assertTrue(ended, "the old call gets the session answer: its session is gone, as require_session would say")
        self.assertEqual(self.auth.sessions.get(new_id).access_token, "new-login-token")
        self.assertEqual(self.route.calls, [], "nothing to confirm for a session that is gone")

    async def test_a_renewal_while_an_old_call_waits_keeps_the_session_and_says_nothing(self) -> None:
        old = await self.admitted()
        self.renew("renewed-token")

        ended = await self.auth.login_refused(old, httpx.Response(401, json=REVOKED))

        self.assertFalse(ended, "Eneo's answer goes on: the session is signed in with a newer token")
        self.assertEqual(self.held_token(), "renewed-token")
        self.assertEqual(self.route.calls, [])

    async def test_a_renewal_while_the_check_waits_keeps_the_session_and_says_nothing(self) -> None:
        asked, answer = asyncio.Event(), asyncio.Event()

        async def confirms():
            asked.set()
            await answer.wait()
            return httpx.Response(401, json=REVOKED)

        self.route.answer = confirms
        request = await self.admitted()
        refusal = asyncio.create_task(self.auth.login_refused(request, httpx.Response(401, json=REVOKED)))
        await asyncio.wait_for(asked.wait(), 1)
        self.renew("renewed-token")
        answer.set()

        self.assertFalse(await refusal, "the old token's end is not the renewed session's")
        self.assertEqual(self.held_token(), "renewed-token")
        self.assertEqual(len(self.route.calls), 1)

    async def test_two_refusals_of_the_same_token_both_end_it_and_it_ends_once(self) -> None:
        # A page asks for a run's status and its graph at once: both come back refused.
        asked, answer = asyncio.Event(), asyncio.Event()

        async def confirms():
            if len(self.route.calls) == 2:
                asked.set()
            await answer.wait()
            return httpx.Response(401, json=REVOKED)

        self.route.answer = confirms
        first, second = await self.admitted(), await self.admitted()
        ends = []
        notify = self.auth.sessions._notify_locked
        with patch.object(self.auth.sessions, "_notify_locked", lambda session_id: (ends.append(session_id), notify(session_id))):
            refusals = asyncio.gather(
                self.auth.login_refused(first, httpx.Response(401, json=REVOKED)),
                self.auth.login_refused(second, httpx.Response(401, json=REVOKED)),
            )
            await asyncio.wait_for(asked.wait(), 1)
            answer.set()
            results = await refusals

        self.assertEqual(results, [True, True], "both get the session answer")
        self.assertIsNone(self.auth.sessions.get(self.session_id))
        self.assertEqual(ends, [self.session_id], "the session ended once")
        self.assertEqual(len(self.route.calls), 2, "at most one check per refusal")

    async def test_a_refusal_after_the_session_ended_gets_the_answer_without_a_check(self) -> None:
        self.route.answer = httpx.Response(401, json=REVOKED)
        first, second = await self.admitted(), await self.admitted()
        self.assertTrue(await self.auth.login_refused(first, httpx.Response(401, json=REVOKED)))

        self.assertTrue(await self.auth.login_refused(second, httpx.Response(401, json=REVOKED)))
        self.assertEqual(len(self.route.calls), 1)

    async def test_the_end_reaches_a_socket_waiting_on_the_session(self) -> None:
        self.route.answer = httpx.Response(401, json=REVOKED)
        request = await self.admitted()
        waiting = asyncio.create_task(self.auth.sessions.ended(self.session_id))
        await asyncio.sleep(0)

        await self.auth.login_refused(request, httpx.Response(401, json=REVOKED))

        await asyncio.wait_for(waiting, 1)


if __name__ == "__main__":
    unittest.main()
