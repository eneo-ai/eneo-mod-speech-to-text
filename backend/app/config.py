from __future__ import annotations

import os
import re
from urllib.parse import urlsplit

from pydantic import BaseModel


class Settings(BaseModel):
    eneo_backend_url: str
    eneo_public_url: str
    module_public_url: str
    module_key: str
    eneo_api_key: str
    eneo_api_key_header_name: str = "X-API-Key"
    session_secret: str
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
    required = [
        "ENEO_BACKEND_URL",
        "ENEO_PUBLIC_URL",
        "MODULE_PUBLIC_URL",
        "MODULE_KEY",
        "ENEO_API_KEY",
        "SESSION_SECRET",
    ]
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

    return Settings(
        eneo_backend_url=_required_url("ENEO_BACKEND_URL"),
        eneo_public_url=_required_url("ENEO_PUBLIC_URL"),
        module_public_url=_required_url("MODULE_PUBLIC_URL"),
        module_key=module_key,
        eneo_api_key=os.environ["ENEO_API_KEY"],
        eneo_api_key_header_name=api_key_header_name,
        session_secret=session_secret,
        cookie_secure=_parse_bool(os.environ.get("COOKIE_SECURE"), default=True),
        demo_space_id=os.environ.get("DEMO_SPACE_ID") or None,
        demo_space_name=os.environ.get("DEMO_SPACE_NAME") or None,
        upload_proxy_timeout_seconds=upload_timeout,
    )
