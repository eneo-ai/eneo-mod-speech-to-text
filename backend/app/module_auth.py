from __future__ import annotations

import logging
import secrets
import threading
import time
from typing import Annotated, Literal
from urllib.parse import quote, urlencode

import httpx
from fastapi import APIRouter, Cookie, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel, Field, ValidationError

from app.config import AuthMode, Settings

logger = logging.getLogger("eneo_module_auth")

SESSION_COOKIE = "eneo_module_session"
STATE_COOKIE = "eneo_module_login_state"
# Upper bound on the browser session cookie. In SSO mode the effective
# lifetime is min(this, Eneo's token expiry); keep it aligned with Eneo's
# module_auth_token_expiry_minutes so this cap never silently shortens the
# token-backed session.
STATE_MAX_AGE = 5 * 60
SESSION_MAX_AGE = 60 * 60
CALLBACK_PATH = "/api/auth/callback"


class ModuleUser(BaseModel):
    id: str
    email: str
    username: str | None = None


class ModuleTokenResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"]
    expires_in: int
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
    expires_at: int
    module_key: str
    tenant_id: str
    user: ModuleUser


class AccessCodeSession(BaseModel):
    auth_mode: Literal["access_code"] = "access_code"
    expires_at: int


ModuleSession = EneoSsoSession | AccessCodeSession


class AccessCodeLoginRequest(BaseModel):
    access_code: str = Field(min_length=1, max_length=256)


class PendingLogin(BaseModel):
    state: str


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

    async def login(self) -> RedirectResponse:
        self._require_auth_mode("eneo_sso")
        if self.settings.eneo_public_url is None:
            raise RuntimeError("ENEO_PUBLIC_URL is required for Eneo SSO")
        state = secrets.token_urlsafe(32)
        pending = self.state_serializer.dumps(PendingLogin(state=state).model_dump())
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

        max_age = SESSION_MAX_AGE
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

        if token.module_key != self.settings.module_key or token.expires_in <= 0:
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

        max_age = min(token.expires_in, SESSION_MAX_AGE)
        session = EneoSsoSession(
            access_token=token.access_token,
            expires_at=int(time.time()) + max_age,
            module_key=token.module_key,
            tenant_id=token.tenant_id,
            user=token.user,
        )
        response = RedirectResponse(url="/flows", status_code=303)
        self._set_session_cookie(response, session=session, max_age=max_age)
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
        session = self.sessions.get(session_id)
        if session is None or session.auth_mode != self.settings.auth_mode:
            return {
                "authenticated": False,
                "auth_mode": self.settings.auth_mode,
                "user": None,
            }
        user = (
            session.user.model_dump(exclude_none=True)
            if isinstance(session, EneoSsoSession)
            else None
        )
        return {
            "authenticated": True,
            "auth_mode": self.settings.auth_mode,
            "user": user,
        }

    async def require_session(
        self,
        request: Request,
        session_id: Annotated[
            str | None,
            Cookie(alias=SESSION_COOKIE),
        ] = None,
    ) -> ModuleSession:
        session = self.sessions.get(session_id)
        if session is None or session.auth_mode != self.settings.auth_mode:
            raise HTTPException(
                status_code=401,
                detail="Not authenticated",
                headers={"X-Auth-Required": "session"},
            )
        request.state.module_session = session
        return session

    def require_same_origin(self, request: Request) -> None:
        if request.method in {"GET", "HEAD", "OPTIONS"}:
            return
        if request.headers.get("origin") != self.settings.module_origin:
            raise HTTPException(status_code=403, detail="Invalid request origin")

    @staticmethod
    def session_from_request(request: Request) -> ModuleSession:
        session = getattr(request.state, "module_session", None)
        if not isinstance(session, (EneoSsoSession, AccessCodeSession)):
            raise RuntimeError("Module session dependency did not run")
        return session

    def upstream_auth_headers(self, request: Request) -> dict[str, str]:
        session = self.session_from_request(request)
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
