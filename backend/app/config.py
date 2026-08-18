from __future__ import annotations

import os
import re
from typing import Literal, cast
from urllib.parse import urlsplit

from pydantic import BaseModel, SecretStr


AuthMode = Literal["eneo_sso", "access_code"]


class Settings(BaseModel):
    eneo_backend_url: str
    eneo_public_url: str | None
    module_public_url: str
    module_key: str
    eneo_api_key: str
    eneo_api_key_header_name: str = "X-API-Key"
    session_secret: str
    auth_mode: AuthMode = "eneo_sso"
    app_access_code: SecretStr | None = None
    cookie_secure: bool = True
    demo_space_id: str | None = None
    demo_space_name: str | None = None
    upload_proxy_timeout_seconds: float = 1800.0

    @property
    def module_origin(self) -> str:
        parsed = urlsplit(self.module_public_url)
        return f"{parsed.scheme}://{parsed.netloc}"


def _parse_bool(raw: str | None, *, default: bool) -> bool:
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"true", "1", "yes", "on"}:
        return True
    if normalized in {"false", "0", "no", "off"}:
        return False
    raise RuntimeError("COOKIE_SECURE must be a boolean")


def _required_url(name: str) -> str:
    value = os.environ[name].rstrip("/")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RuntimeError(f"{name} must be an absolute http(s) URL")
    if parsed.query or parsed.fragment:
        raise RuntimeError(f"{name} must not contain a query string or fragment")
    return value


def load_settings() -> Settings:
    raw_auth_mode = os.environ.get("AUTH_MODE", "eneo_sso")
    if raw_auth_mode not in {"eneo_sso", "access_code"}:
        raise RuntimeError("AUTH_MODE must be either eneo_sso or access_code")
    auth_mode = cast(AuthMode, raw_auth_mode)

    required = [
        "ENEO_BACKEND_URL",
        "MODULE_PUBLIC_URL",
        "MODULE_KEY",
        "ENEO_API_KEY",
        "SESSION_SECRET",
    ]
    if auth_mode == "eneo_sso":
        required.append("ENEO_PUBLIC_URL")
    else:
        required.append("APP_ACCESS_CODE")
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        raise RuntimeError(
            f"Missing required environment variables: {', '.join(missing)}"
        )

    session_secret = os.environ["SESSION_SECRET"]
    if len(session_secret) < 32:
        raise RuntimeError("SESSION_SECRET must be at least 32 characters")

    module_key = os.environ["MODULE_KEY"]
    if re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", module_key) is None:
        raise RuntimeError("MODULE_KEY must use lowercase kebab-case")

    api_key_header_name = os.environ.get("ENEO_API_KEY_HEADER_NAME", "X-API-Key")
    if re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", api_key_header_name) is None:
        raise RuntimeError("ENEO_API_KEY_HEADER_NAME must be a valid HTTP header name")

    upload_timeout = float(os.environ.get("UPLOAD_PROXY_TIMEOUT_SECONDS", "1800"))
    if upload_timeout <= 0:
        raise RuntimeError("UPLOAD_PROXY_TIMEOUT_SECONDS must be greater than zero")

    raw_access_code = os.environ.get("APP_ACCESS_CODE")
    if auth_mode == "eneo_sso" and raw_access_code:
        raise RuntimeError("APP_ACCESS_CODE may only be set with AUTH_MODE=access_code")
    if auth_mode == "access_code" and raw_access_code is not None:
        if not 16 <= len(raw_access_code) <= 256:
            raise RuntimeError("APP_ACCESS_CODE must be between 16 and 256 characters")

    return Settings(
        eneo_backend_url=_required_url("ENEO_BACKEND_URL"),
        eneo_public_url=(
            _required_url("ENEO_PUBLIC_URL") if auth_mode == "eneo_sso" else None
        ),
        module_public_url=_required_url("MODULE_PUBLIC_URL"),
        module_key=module_key,
        eneo_api_key=os.environ["ENEO_API_KEY"],
        eneo_api_key_header_name=api_key_header_name,
        session_secret=session_secret,
        auth_mode=auth_mode,
        app_access_code=(
            SecretStr(raw_access_code)
            if auth_mode == "access_code" and raw_access_code is not None
            else None
        ),
        cookie_secure=_parse_bool(os.environ.get("COOKIE_SECURE"), default=True),
        demo_space_id=os.environ.get("DEMO_SPACE_ID") or None,
        demo_space_name=os.environ.get("DEMO_SPACE_NAME") or None,
        upload_proxy_timeout_seconds=upload_timeout,
    )
