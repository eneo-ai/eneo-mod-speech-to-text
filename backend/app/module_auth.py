from __future__ import annotations

import asyncio
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
from pydantic import BaseModel, Field, ValidationError

from app.config import AuthMode, Settings

logger = logging.getLogger("eneo_module_auth")

SESSION_COOKIE = "eneo_module_session"
STATE_COOKIE = "eneo_module_login_state"
# The browser session cookie's upper bound is Settings.session_max_age_seconds
# (SESSION_MAX_AGE_MINUTES). In SSO mode the session also ends at Eneo's
# session ceiling (module_auth_max_session_hours); the shorter-lived module
# token is refreshed through Eneo until then.
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
    auth_mode: Literal["eneo_sso"] = "eneo_sso"
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


class AccessCodeSession(BaseModel):
    auth_mode: Literal["access_code"] = "access_code"
    expires_at: int


ModuleSession = EneoSsoSession | AccessCodeSession


class AccessCodeLoginRequest(BaseModel):
    access_code: str = Field(min_length=1, max_length=256)


class PendingLogin(BaseModel):
    state: str
    # Where the callback sends the browser: a path of this module, never elsewhere.
    next: str = "/flows"
    # A renewal before the session ends may only renew the same user in the same tenant.
    renew_user_id: str | None = None
    renew_tenant_id: str | None = None


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
        self._sessions: dict[str, ModuleSession] = {}
        self._lock = threading.Lock()

    def create(self, session: ModuleSession) -> str:
        session_id = secrets.token_urlsafe(32)
        with self._lock:
            self._delete_expired_locked(time.time())
            self._sessions[session_id] = session
        return session_id

    def get(self, session_id: str | None) -> ModuleSession | None:
        if session_id is None:
            return None
        with self._lock:
            now = time.time()
            self._delete_expired_locked(now)
            session = self._sessions.get(session_id)
            if session is None or session.expires_at <= now:
                self._sessions.pop(session_id, None)
                return None
            return session

    def replace(self, session_id: str, session: ModuleSession) -> None:
        # Only a live session: a logout during a token refresh stays a logout.
        with self._lock:
            if session_id in self._sessions:
                self._sessions[session_id] = session

    def delete(self, session_id: str | None) -> None:
        if session_id is None:
            return
        with self._lock:
            self._sessions.pop(session_id, None)

    def clear(self) -> None:
        with self._lock:
            self._sessions.clear()

    def _delete_expired_locked(self, now: float) -> None:
        expired = [
            session_id
            for session_id, session in self._sessions.items()
            if session.expires_at <= now
        ]
        for session_id in expired:
            del self._sessions[session_id]


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
        self.router.add_api_route(
            "/login",
            self.login_with_access_code,
            methods=["POST"],
        )
        self.router.add_api_route("/callback", self.callback, methods=["GET"])
        self.router.add_api_route("/logout", self.logout, methods=["POST"])
        self.router.add_api_route("/status", self.status, methods=["GET"])
        if settings.auth_mode == "access_code":
            logger.warning(
                "AUTH_MODE=access_code is enabled; use only as a temporary test gate"
            )

    @property
    def callback_url(self) -> str:
        return f"{self.settings.module_public_url}{CALLBACK_PATH}"

    async def login(
        self,
        next_path: Annotated[str | None, Query(alias="next")] = None,
        renew: Annotated[bool, Query()] = False,
        session_id: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    ) -> RedirectResponse:
        self._require_auth_mode("eneo_sso")
        if self.settings.eneo_public_url is None:
            raise RuntimeError("ENEO_PUBLIC_URL is required for Eneo SSO")
        state = secrets.token_urlsafe(32)
        # A login in a separate window (before the session ends) returns to a page that closes it, and is
        # bound to the user signed in now, so the page's work never passes to someone else.
        current = self.sessions.get(session_id) if renew else None
        pending = self.state_serializer.dumps(
            PendingLogin(
                state=state,
                next=module_path(next_path),
                renew_user_id=current.user.id if isinstance(current, EneoSsoSession) else None,
                renew_tenant_id=current.tenant_id if isinstance(current, EneoSsoSession) else None,
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

    async def login_with_access_code(
        self,
        payload: AccessCodeLoginRequest,
        request: Request,
        response: Response,
    ) -> dict[str, bool]:
        self._require_auth_mode("access_code")
        self.require_same_origin(request)
        configured_code = self.settings.app_access_code
        if configured_code is None:
            raise RuntimeError("APP_ACCESS_CODE is required for access-code auth")
        if not secrets.compare_digest(
            payload.access_code.encode("utf-8"),
            configured_code.get_secret_value().encode("utf-8"),
        ):
            raise HTTPException(
                status_code=401,
                detail="Invalid access code",
                headers={"Cache-Control": "no-store"},
            )

        max_age = self.settings.session_max_age_seconds
        session = AccessCodeSession(expires_at=int(time.time()) + max_age)
        self._set_session_cookie(response, session=session, max_age=max_age)
        response.headers["Cache-Control"] = "no-store"
        return {"ok": True}

    async def callback(
        self,
        ticket: Annotated[str | None, Query()] = None,
        state: Annotated[str | None, Query()] = None,
        pending_cookie: Annotated[
            str | None,
            Cookie(alias=STATE_COOKIE),
        ] = None,
    ) -> RedirectResponse:
        self._require_auth_mode("eneo_sso")
        pending = self._load_pending_login(pending_cookie)
        if (
            ticket is None
            or state is None
            or pending is None
            or not secrets.compare_digest(state, pending.state)
        ):
            return self._auth_error("invalid_state")

        try:
            upstream = await self.http_client.post(
                f"{self.settings.eneo_backend_url}/api/v1/module-auth/token/",
                headers={
                    self.settings.eneo_api_key_header_name: self.settings.eneo_api_key
                },
                json={"ticket": ticket},
                timeout=httpx.Timeout(10.0),
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
            logger.exception("Module ticket exchange returned an invalid response")
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
                timeout=httpx.Timeout(10.0),
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
            logger.exception("Module session validation returned an invalid response")
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
            joiner = "&" if "?" in pending.next else "?"
            response = RedirectResponse(url=f"{pending.next}{joiner}fel=annan-anvandare", status_code=303)
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
            return {
                "authenticated": False,
                "auth_mode": self.settings.auth_mode,
                "user": None,
            }
        status: dict[str, object] = {
            "authenticated": True,
            "auth_mode": self.settings.auth_mode,
            "user": None,
        }
        # The login's fixed end (Eneo's ceiling or the module's own), so the page can warn before it.
        ends_at = session.session_expires_at if isinstance(session, EneoSsoSession) else session.expires_at
        status["session_ends_in"] = max(0, ends_at - int(time.time()))
        if isinstance(session, EneoSsoSession):
            status["user"] = session.user.model_dump(exclude_none=True)
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
    ) -> ModuleSession:
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

    async def _live_session(self, session_id: str | None) -> ModuleSession | None:
        """The caller's session, with its module token refreshed once due."""
        if session_id is None:
            return None
        session = self.sessions.get(session_id)
        if session is None or session.auth_mode != self.settings.auth_mode:
            return None
        if isinstance(session, EneoSsoSession) and session.refresh_due():
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
                timeout=httpx.Timeout(10.0),
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
            logger.exception("Module token refresh returned an invalid response")
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
    def session_from_request(connection: HTTPConnection) -> ModuleSession:
        session = getattr(connection.state, "module_session", None)
        if not isinstance(session, (EneoSsoSession, AccessCodeSession)):
            raise RuntimeError("Module session dependency did not run")
        return session

    def upstream_auth_headers(self, connection: HTTPConnection) -> dict[str, str]:
        session = self.session_from_request(connection)
        headers = {
            self.settings.eneo_api_key_header_name: self.settings.eneo_api_key,
        }
        if isinstance(session, EneoSsoSession):
            headers["Authorization"] = f"Bearer {session.access_token}"
        return headers

    def _require_auth_mode(self, expected: AuthMode) -> None:
        if self.settings.auth_mode != expected:
            raise HTTPException(
                status_code=404,
                detail="Authentication route is not available",
            )

    def _set_session_cookie(
        self,
        response: Response,
        *,
        session: ModuleSession,
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
