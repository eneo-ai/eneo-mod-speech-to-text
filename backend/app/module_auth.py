from __future__ import annotations

import logging
import secrets
import time
from typing import Annotated, Literal
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Cookie, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel, ValidationError

from app.config import Settings

logger = logging.getLogger("eneo_module_auth")

SESSION_COOKIE = "eneo_module_session"
STATE_COOKIE = "eneo_module_login_state"
STATE_MAX_AGE = 5 * 60
SESSION_MAX_AGE = 15 * 60
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


class ModuleSession(BaseModel):
    access_token: str
    expires_at: int
    module_key: str
    tenant_id: str
    user: ModuleUser


class PendingLogin(BaseModel):
    state: str


class ModuleAuth:
    def __init__(
        self,
        *,
        settings: Settings,
        http_client: httpx.AsyncClient,
    ) -> None:
        self.settings = settings
        self.http_client = http_client
        self.session_serializer = URLSafeTimedSerializer(
            settings.session_secret,
            salt="eneo-module-session",
        )
        self.state_serializer = URLSafeTimedSerializer(
            settings.session_secret,
            salt="eneo-module-login-state",
        )
        self.router = APIRouter()
        self.router.add_api_route("/login", self.login, methods=["GET"])
        self.router.add_api_route("/callback", self.callback, methods=["GET"])
        self.router.add_api_route("/logout", self.logout, methods=["POST"])
        self.router.add_api_route("/status", self.status, methods=["GET"])

    @property
    def callback_url(self) -> str:
        return f"{self.settings.module_public_url}{CALLBACK_PATH}"

    async def login(self) -> RedirectResponse:
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

    async def callback(
        self,
        ticket: Annotated[str | None, Query()] = None,
        state: Annotated[str | None, Query()] = None,
        pending_cookie: Annotated[
            str | None,
            Cookie(alias=STATE_COOKIE),
        ] = None,
    ) -> RedirectResponse:
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
                headers={"X-API-Key": self.settings.eneo_api_key},
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

        max_age = min(token.expires_in, SESSION_MAX_AGE)
        session = ModuleSession(
            access_token=token.access_token,
            expires_at=int(time.time()) + max_age,
            module_key=token.module_key,
            tenant_id=token.tenant_id,
            user=token.user,
        )
        response = RedirectResponse(url="/flows", status_code=303)
        response.set_cookie(
            key=SESSION_COOKIE,
            value=self.session_serializer.dumps(session.model_dump()),
            httponly=True,
            secure=self.settings.cookie_secure,
            samesite="lax",
            max_age=max_age,
            path="/",
        )
        self._delete_state_cookie(response)
        self._secure_callback_response(response)
        return response

    async def logout(self, request: Request, response: Response) -> dict[str, bool]:
        self.require_same_origin(request)
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
        session_cookie: Annotated[
            str | None,
            Cookie(alias=SESSION_COOKIE),
        ] = None,
    ) -> dict[str, object]:
        response.headers["Cache-Control"] = "no-store"
        session = self._load_session(session_cookie)
        if session is None:
            return {"authenticated": False, "user": None}
        return {
            "authenticated": True,
            "user": session.user.model_dump(exclude_none=True),
        }

    async def require_session(
        self,
        request: Request,
        session_cookie: Annotated[
            str | None,
            Cookie(alias=SESSION_COOKIE),
        ] = None,
    ) -> ModuleSession:
        session = self._load_session(session_cookie)
        if session is None:
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
        if not isinstance(session, ModuleSession):
            raise RuntimeError("Module session dependency did not run")
        return session

    def _load_pending_login(self, cookie: str | None) -> PendingLogin | None:
        if cookie is None:
            return None
        try:
            payload = self.state_serializer.loads(cookie, max_age=STATE_MAX_AGE)
            return PendingLogin.model_validate(payload)
        except (BadSignature, SignatureExpired, ValidationError):
            return None

    def _load_session(self, cookie: str | None) -> ModuleSession | None:
        if cookie is None:
            return None
        try:
            payload = self.session_serializer.loads(cookie, max_age=SESSION_MAX_AGE)
            session = ModuleSession.model_validate(payload)
        except (BadSignature, SignatureExpired, ValidationError):
            return None
        if (
            session.module_key != self.settings.module_key
            or session.expires_at <= time.time()
        ):
            return None
        return session

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
