from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import secrets
import threading
import time
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import quote, urlencode

import httpx
from fastapi import (
    APIRouter,
    Cookie,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocketException,
    status,
)
from fastapi.requests import HTTPConnection
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel, ValidationError

from app.config import Settings
from app.upstream import SMALL_ANSWER, SMALL_CALL_TIMEOUT

logger = logging.getLogger("eneo_module_auth")

SESSION_COOKIE = "eneo_module_session"
STATE_COOKIE = "eneo_module_login_state"
# The browser session cookie's upper bound is Settings.session_max_age_seconds
# (SESSION_MAX_AGE_MINUTES). The session also ends at Eneo's session ceiling
# (module_auth_max_session_hours); the shorter-lived module token is refreshed
# through Eneo until then.
STATE_MAX_AGE = 5 * 60
CALLBACK_PATH = "/api/auth/callback"
# After Eneo fails to answer a token refresh, wait this long before asking
# again; the current, still valid token stays in use meanwhile.
REFRESH_RETRY_SECONDS = 10


class ModuleUser(BaseModel):
    id: str
    email: str
    username: str | None = None


class ModuleTokenResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"]
    expires_in: int
    # Eneo's fixed session ceiling; refresh renews the token only until then.
    session_expires_at: datetime
    module_key: str
    tenant_id: str
    user: ModuleUser


class ModuleResourceSessionResponse(BaseModel):
    module_key: str
    tenant_id: str
    user: ModuleUser


class EneoSsoSession(BaseModel):
    access_token: str
    # When the current token expires; the store drops the session then,
    # because Eneo refuses to refresh an expired token.
    expires_at: int
    # Halfway through the token's lifetime, or a short while after Eneo
    # failed to answer: refresh from here on.
    refresh_at: int
    # Fixed end of the login: min(SESSION_MAX_AGE_MINUTES, Eneo's ceiling).
    session_expires_at: int
    module_key: str
    tenant_id: str
    user: ModuleUser

    def refresh_in(self) -> int | None:
        """Seconds until a request should refresh the token.

        None when a new token could not outlive the current one, because the
        current one already reaches the session end.
        """
        if self.expires_at >= self.session_expires_at:
            return None
        return max(0, math.ceil(self.refresh_at - time.time()))

    def refresh_due(self) -> bool:
        return self.refresh_in() == 0


class PendingLogin(BaseModel):
    state: str
    # Where the callback sends the browser: a path of this module, never elsewhere.
    next: str = "/flows"
    # A renewal before the session ends may only renew the same user in the same tenant.
    renew_user_id: str | None = None
    renew_tenant_id: str | None = None


def with_query(path: str, query: str) -> str:
    return f"{path}{'&' if '?' in path else '?'}{query}"


def module_path(value: str | None) -> str:
    """``value`` when it is a path on the module's own origin, else the flow list."""
    if value and value.startswith("/") and not value.startswith("//") and "\\" not in value:
        return value
    return "/flows"


class ModuleSessionStore:
    """Process-local opaque sessions for the single-process module image.

    The browser receives only a random identifier. Any Eneo user token remains
    in backend memory and logout removes the session immediately. A shared
    store is required before running more than one backend replica.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, EneoSsoSession] = {}
        self._lock = threading.Lock()
        # Who is waiting for a session to end (a live socket), by session id: the loop to wake and its event.
        self._watchers: dict[str, list[tuple[asyncio.AbstractEventLoop, asyncio.Event]]] = {}

    def create(self, session: EneoSsoSession) -> str:
        session_id = secrets.token_urlsafe(32)
        with self._lock:
            self._delete_expired_locked(time.time())
            self._sessions[session_id] = session
        return session_id

    def get(self, session_id: str | None) -> EneoSsoSession | None:
        if session_id is None:
            return None
        with self._lock:
            now = time.time()
            self._delete_expired_locked(now)
            session = self._sessions.get(session_id)
            if session is None or session.expires_at <= now:
                if self._sessions.pop(session_id, None) is not None:
                    self._notify_locked(session_id)
                return None
            return session

    def replace(self, session_id: str, session: EneoSsoSession) -> None:
        # Only a live session: a logout during a token refresh stays a logout.
        with self._lock:
            if session_id in self._sessions:
                self._sessions[session_id] = session

    def delete(self, session_id: str | None) -> None:
        if session_id is None:
            return
        with self._lock:
            if self._sessions.pop(session_id, None) is not None:
                self._notify_locked(session_id)

    def clear(self) -> None:
        with self._lock:
            for session_id in list(self._sessions):
                self._notify_locked(session_id)
            self._sessions.clear()

    def _delete_expired_locked(self, now: float) -> None:
        expired = [
            session_id
            for session_id, session in self._sessions.items()
            if session.expires_at <= now
        ]
        for session_id in expired:
            del self._sessions[session_id]
            self._notify_locked(session_id)

    def _notify_locked(self, session_id: str) -> None:
        for loop, event in self._watchers.get(session_id, ()):
            with contextlib.suppress(RuntimeError):  # the watcher's loop has closed
                loop.call_soon_threadsafe(event.set)

    async def ended(self, session_id: str | None) -> None:
        """Returns when the session is gone: logged out, replaced by a new login, refused a refresh, or expired.

        The one signal a long-lived connection (the live socket) subscribes to, so that it ends with the session even
        when nothing is sent over it. An expiry is noticed at the session's own time, and a session that is refreshed
        meanwhile (its ``expires_at`` moves) is waited for again until its new end.
        """
        if session_id is None:
            return
        event = asyncio.Event()
        watcher = (asyncio.get_running_loop(), event)
        with self._lock:
            self._watchers.setdefault(session_id, []).append(watcher)
        try:
            while (session := self.get(session_id)) is not None:
                try:
                    await asyncio.wait_for(event.wait(), max(0.0, session.expires_at - time.time()) + 0.05)
                    return
                except TimeoutError:
                    continue
        finally:
            with self._lock:
                watchers = self._watchers.get(session_id, [])
                if watcher in watchers:
                    watchers.remove(watcher)
                if not watchers:
                    self._watchers.pop(session_id, None)


def eneo_is_unavailable(status_code: int) -> bool:
    """Eneo could not answer right now, as opposed to refusing."""
    return status_code in {408, 429} or status_code >= 500


def _refusal(connection: HTTPConnection, error: HTTPException) -> Exception:
    """``error`` for an HTTP request; a WebSocket handshake is closed unaccepted."""
    if connection.scope["type"] == "websocket":
        return WebSocketException(
            code=status.WS_1008_POLICY_VIOLATION, reason=str(error.detail)
        )
    return error


class ModuleAuth:
    def __init__(
        self,
        *,
        settings: Settings,
        http_client: httpx.AsyncClient,
    ) -> None:
        self.settings = settings
        self.http_client = http_client
        self.state_serializer = URLSafeTimedSerializer(
            settings.session_secret,
            salt="eneo-module-login-state",
        )
        self.sessions = ModuleSessionStore()
        # Token refreshes in flight, by session id; an entry lives only while
        # its refresh runs.
        self._refreshes: dict[str, asyncio.Task[None]] = {}
        self.router = APIRouter()
        self.router.add_api_route("/login", self.login, methods=["GET"])
        self.router.add_api_route("/callback", self.callback, methods=["GET"])
        self.router.add_api_route("/logout", self.logout, methods=["POST"])
        self.router.add_api_route("/status", self.status, methods=["GET"])

    @property
    def callback_url(self) -> str:
        return f"{self.settings.module_public_url}{CALLBACK_PATH}"

    async def login(
        self,
        next_path: Annotated[str | None, Query(alias="next")] = None,
        renew: Annotated[bool, Query()] = False,
        session_id: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    ) -> RedirectResponse:
        state = secrets.token_urlsafe(32)
        # A login in a separate window (before the session ends) returns to a page that closes it, and is
        # bound to the user signed in now, so the page's work never passes to someone else.
        current = self.sessions.get(session_id) if renew else None
        if renew and current is None:
            # Nobody left to bind to: refused, not an ordinary login that anyone could finish under this page.
            refused = RedirectResponse(url=with_query(module_path(next_path), "fel=utgangen"), status_code=303)
            refused.headers["Cache-Control"] = "no-store"
            return refused
        pending = self.state_serializer.dumps(
            PendingLogin(
                state=state,
                next=module_path(next_path),
                renew_user_id=current.user.id if current else None,
                renew_tenant_id=current.tenant_id if current else None,
            ).model_dump()
        )
        query = urlencode(
            {
                "module_key": self.settings.module_key,
                "redirect_uri": self.callback_url,
                "state": state,
            }
        )
        response = RedirectResponse(
            url=f"{self.settings.eneo_public_url}/module-login?{query}",
            status_code=303,
        )
        response.set_cookie(
            key=STATE_COOKIE,
            value=pending,
            httponly=True,
            secure=self.settings.cookie_secure,
            samesite="lax",
            max_age=STATE_MAX_AGE,
            path=CALLBACK_PATH,
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    async def callback(
        self,
        ticket: Annotated[str | None, Query()] = None,
        state: Annotated[str | None, Query()] = None,
        pending_cookie: Annotated[
            str | None,
            Cookie(alias=STATE_COOKIE),
        ] = None,
        replaced_session_id: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    ) -> RedirectResponse:
        pending = self._load_pending_login(pending_cookie)
        if (
            ticket is None
            or state is None
            or pending is None
            # Bytes, not str: compare_digest raises TypeError (a 500) for a str with a non-ASCII character.
            or not secrets.compare_digest(state.encode(), pending.state.encode())
        ):
            return self._auth_error("invalid_state")

        try:
            upstream = await self.http_client.post(
                f"{self.settings.eneo_backend_url}/api/v1/module-auth/token/",
                headers={
                    self.settings.eneo_api_key_header_name: self.settings.eneo_api_key
                },
                json={"ticket": ticket},
                timeout=SMALL_CALL_TIMEOUT,
                extensions=SMALL_ANSWER,
            )
        except httpx.RequestError:
            logger.exception("Module ticket exchange could not reach Eneo")
            return self._auth_error("exchange_unavailable")

        if upstream.status_code != 200:
            logger.warning(
                "Module ticket exchange failed with status %s",
                upstream.status_code,
            )
            return self._auth_error("exchange_failed")

        try:
            token = ModuleTokenResponse.model_validate(upstream.json())
        except (ValueError, ValidationError):
            # Not the exception, here and in the two like it below: a validation error quotes the input it refused,
            # and that is an access token.
            logger.error("Module ticket exchange returned an invalid response")
            return self._auth_error("exchange_invalid")

        now = int(time.time())
        session_expires_at = min(
            now + self.settings.session_max_age_seconds,
            int(token.session_expires_at.timestamp()),
        )
        if (
            token.module_key != self.settings.module_key
            or token.expires_in <= 0
            or session_expires_at <= now
        ):
            logger.error("Module ticket exchange returned the wrong module or expiry")
            return self._auth_error("exchange_invalid")

        try:
            validation = await self.http_client.get(
                (
                    f"{self.settings.eneo_backend_url}/api/v1/module-auth/"
                    f"{quote(self.settings.module_key, safe='')}/session/"
                ),
                headers={
                    self.settings.eneo_api_key_header_name: self.settings.eneo_api_key,
                    "Authorization": f"Bearer {token.access_token}",
                },
                timeout=SMALL_CALL_TIMEOUT,
                extensions=SMALL_ANSWER,
            )
        except httpx.RequestError:
            logger.exception("Module session validation could not reach Eneo")
            return self._auth_error("validation_unavailable")

        if validation.status_code != 200:
            logger.warning(
                "Module session validation failed with status %s",
                validation.status_code,
            )
            return self._auth_error("validation_failed")
        try:
            validated = ModuleResourceSessionResponse.model_validate(validation.json())
        except (ValueError, ValidationError):
            logger.error("Module session validation returned an invalid response")
            return self._auth_error("validation_invalid")
        if (
            validated.module_key != token.module_key
            or validated.tenant_id != token.tenant_id
            or validated.user.id != token.user.id
        ):
            logger.error("Module session validation returned a different identity")
            return self._auth_error("validation_invalid")

        if pending.renew_user_id is not None and (
            token.user.id != pending.renew_user_id or token.tenant_id != pending.renew_tenant_id
        ):
            logger.warning("A session renewal signed in a different user; the session is kept")
            response = RedirectResponse(url=with_query(pending.next, "fel=annan-anvandare"), status_code=303)
            self._delete_state_cookie(response)
            self._secure_callback_response(response)
            return response

        session = EneoSsoSession(
            access_token=token.access_token,
            expires_at=min(now + token.expires_in, session_expires_at),
            refresh_at=now + token.expires_in // 2,
            session_expires_at=session_expires_at,
            module_key=token.module_key,
            tenant_id=token.tenant_id,
            user=token.user,
        )
        response = RedirectResponse(url=pending.next, status_code=303)
        self._set_session_cookie(
            response, session=session, max_age=session_expires_at - now
        )
        # The browser has the new session now: the one it had is over, with whatever is open under it.
        self.sessions.delete(replaced_session_id)
        self._delete_state_cookie(response)
        self._secure_callback_response(response)
        return response

    async def logout(
        self,
        request: Request,
        response: Response,
        session_id: Annotated[
            str | None,
            Cookie(alias=SESSION_COOKIE),
        ] = None,
    ) -> dict[str, bool]:
        self.require_same_origin(request)
        self.sessions.delete(session_id)
        response.delete_cookie(
            SESSION_COOKIE,
            path="/",
            secure=self.settings.cookie_secure,
            httponly=True,
            samesite="lax",
        )
        response.headers["Cache-Control"] = "no-store"
        return {"ok": True}

    async def status(
        self,
        response: Response,
        session_id: Annotated[
            str | None,
            Cookie(alias=SESSION_COOKIE),
        ] = None,
    ) -> dict[str, object]:
        response.headers["Cache-Control"] = "no-store"
        session = await self._live_session(session_id)
        if session is None:
            return {"authenticated": False, "user": None}
        status: dict[str, object] = {
            "authenticated": True,
            "user": session.user.model_dump(exclude_none=True),
            # The login's fixed end (Eneo's ceiling or the module's own), so the page can warn before it.
            "session_ends_in": max(0, session.session_expires_at - int(time.time())),
            # What the page may send in one upload (the whole request, so a file takes a little less): a larger one is
            # refused with a 413 while it is still being sent, which a proxy in front may turn into a 502. Not a secret.
            "max_upload_bytes": self.settings.max_upload_bytes,
        }
        refresh_in = session.refresh_in()
        if refresh_in is not None:
            # The page asks again then, so even a session that sends no
            # other request (a recording) is refreshed before it expires.
            status["refresh_in"] = refresh_in
        return status

    async def require_session(
        self,
        connection: HTTPConnection,
        session_id: Annotated[
            str | None,
            Cookie(alias=SESSION_COOKIE),
        ] = None,
    ) -> EneoSsoSession:
        session = await self._live_session(session_id)
        if session is None:
            raise _refusal(
                connection,
                HTTPException(
                    status_code=401,
                    detail="Not authenticated",
                    headers={"X-Auth-Required": "session"},
                ),
            )
        connection.state.module_session = session
        return session

    async def _live_session(self, session_id: str | None) -> EneoSsoSession | None:
        """The caller's session, with its module token refreshed once due."""
        if session_id is None:
            return None
        session = self.sessions.get(session_id)
        if session is None:
            return None
        if session.refresh_due():
            # One refresh per session: concurrent requests wait for the same
            # one, and a request that goes away does not cancel it for them.
            refresh = self._refreshes.get(session_id)
            if refresh is None:
                refresh = asyncio.create_task(self._refresh(session_id, session))
                self._refreshes[session_id] = refresh
            await asyncio.shield(refresh)
            # Refreshed, retried later or ended meanwhile, and the wait may have
            # outlasted the token: only what the store holds now is valid.
            session = self.sessions.get(session_id)
        return session

    async def _refresh(self, session_id: str, session: EneoSsoSession) -> None:
        try:
            refreshed = await self._refresh_token(session)
            if refreshed is None:
                self.sessions.delete(session_id)
            else:
                self.sessions.replace(session_id, refreshed)
        finally:
            self._refreshes.pop(session_id, None)

    async def _refresh_token(self, session: EneoSsoSession) -> EneoSsoSession | None:
        """Renew the token; None when Eneo refuses, so the user signs in again.

        When Eneo cannot answer right now the session keeps its token, which
        is still valid, and asks again after REFRESH_RETRY_SECONDS.
        """
        try:
            upstream = await self.http_client.post(
                (
                    f"{self.settings.eneo_backend_url}/api/v1/module-auth/"
                    f"{quote(self.settings.module_key, safe='')}/token/refresh/"
                ),
                headers={
                    self.settings.eneo_api_key_header_name: self.settings.eneo_api_key,
                    "Authorization": f"Bearer {session.access_token}",
                },
                timeout=SMALL_CALL_TIMEOUT,
                extensions=SMALL_ANSWER,
            )
        except httpx.RequestError:
            logger.warning("Module token refresh could not reach Eneo", exc_info=True)
            return self._retry_later(session)
        if eneo_is_unavailable(upstream.status_code):
            logger.warning(
                "Module token refresh failed with status %s", upstream.status_code
            )
            return self._retry_later(session)
        if upstream.status_code != 200:
            logger.warning(
                "Eneo refused the module token refresh with status %s",
                upstream.status_code,
            )
            return None
        try:
            token = ModuleTokenResponse.model_validate(upstream.json())
        except (ValueError, ValidationError):
            logger.error("Module token refresh returned an invalid response")
            return None
        if (
            token.module_key != session.module_key
            or token.tenant_id != session.tenant_id
            or token.user.id != session.user.id
            or token.expires_in <= 0
        ):
            logger.error("Module token refresh returned a different identity or expiry")
            return None
        now = int(time.time())
        return session.model_copy(
            update={
                "access_token": token.access_token,
                "expires_at": min(now + token.expires_in, session.session_expires_at),
                "refresh_at": now + token.expires_in // 2,
            }
        )

    @staticmethod
    def _retry_later(session: EneoSsoSession) -> EneoSsoSession:
        return session.model_copy(
            update={"refresh_at": int(time.time()) + REFRESH_RETRY_SECONDS}
        )

    def require_same_origin(self, connection: HTTPConnection) -> None:
        # A WebSocket handshake is a GET too, but the socket it opens acts for
        # the user, so it is checked like a mutation.
        safe_methods = {"GET", "HEAD", "OPTIONS"}
        if isinstance(connection, Request) and connection.method in safe_methods:
            return
        if connection.headers.get("origin") != self.settings.module_origin:
            raise _refusal(
                connection, HTTPException(status_code=403, detail="Invalid request origin")
            )

    @staticmethod
    def is_another_user(
        session: EneoSsoSession,
        expected_user: str | None,
        expected_tenant: str | None = None,
        *,
        required: bool = False,
    ) -> bool:
        """True if the page that made a request is for another person than the session's.

        A browser has one cookie for every tab: a login in one tab replaces the session of an old one, and the old
        page would go on sending audio, or anything else it changes, under the new person's session. The page names
        the user (and the tenant, if it knows it) it was opened for, and the module compares: ids, not secrets. Where
        ``required``, a page that names nobody is refused too: a tab still running a page from before the check sends
        no name.
        """
        if expected_user is None and required:
            return True
        return (expected_user is not None and expected_user != session.user.id) or (
            expected_tenant is not None and expected_tenant != session.tenant_id
        )

    def require_expected_user(self, request: Request) -> None:
        """A dependency of the /api/eneo routes: 409 user_changed, before the body is read, for another user's page.

        The page names its user in ``X-Expected-User`` (and the tenant in ``X-Expected-Tenant``), and must on every
        request that changes something (not GET, HEAD or OPTIONS). A read may name nobody, because an ``<audio src>``
        or a navigation cannot send a header; a name it gives must still be the session's. Run it after
        ``require_session``.
        """
        if self.is_another_user(
            self.session_from_request(request),
            request.headers.get("x-expected-user"),
            request.headers.get("x-expected-tenant"),
            required=request.method not in {"GET", "HEAD", "OPTIONS"},
        ):
            logger.info("A request was refused: its page is for another user than the session's, or for none")
            raise HTTPException(status_code=409, detail="user_changed")

    @staticmethod
    def session_from_request(connection: HTTPConnection) -> EneoSsoSession:
        session = getattr(connection.state, "module_session", None)
        if not isinstance(session, EneoSsoSession):
            raise RuntimeError("Module session dependency did not run")
        return session

    def upstream_auth_headers(self, connection: HTTPConnection) -> dict[str, str]:
        """Eneo's credentials for a call made for this session: the module's key and the user's own token."""
        session = self.session_from_request(connection)
        return {
            self.settings.eneo_api_key_header_name: self.settings.eneo_api_key,
            "Authorization": f"Bearer {session.access_token}",
        }

    def _set_session_cookie(
        self,
        response: Response,
        *,
        session: EneoSsoSession,
        max_age: int,
    ) -> None:
        session_id = self.sessions.create(session)
        response.set_cookie(
            key=SESSION_COOKIE,
            value=session_id,
            httponly=True,
            secure=self.settings.cookie_secure,
            samesite="lax",
            max_age=max_age,
            path="/",
        )

    def _load_pending_login(self, cookie: str | None) -> PendingLogin | None:
        if cookie is None:
            return None
        try:
            payload = self.state_serializer.loads(cookie, max_age=STATE_MAX_AGE)
            return PendingLogin.model_validate(payload)
        except (BadSignature, SignatureExpired, ValidationError):
            return None

    def _auth_error(self, code: str) -> RedirectResponse:
        response = RedirectResponse(
            url=f"/?{urlencode({'auth_error': code})}",
            status_code=303,
        )
        self._delete_state_cookie(response)
        self._secure_callback_response(response)
        return response

    def _delete_state_cookie(self, response: Response) -> None:
        response.delete_cookie(
            STATE_COOKIE,
            path=CALLBACK_PATH,
            secure=self.settings.cookie_secure,
            httponly=True,
            samesite="lax",
        )

    @staticmethod
    def _secure_callback_response(response: Response) -> None:
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
