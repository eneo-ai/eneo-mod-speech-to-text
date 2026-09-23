from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Literal, cast
from urllib.parse import urlsplit

from pydantic import BaseModel, SecretStr


AuthMode = Literal["eneo_sso", "access_code"]

logger = logging.getLogger("eneo_config")


class FlowListScope(BaseModel):
    """What the flow list asks Eneo for: one named space, or every space the user belongs to (None)."""

    space_id: str | None


class Organization(BaseModel):
    """The organisation beside "Tal till text": its name, and its logo.

    ``logo`` is ``default`` for Sundsvall's bundled logo, ``custom`` for the
    deployment's own (served by /api/branding/logo/{light,dark}), or None for
    the name as text.
    """

    name: str
    logo: Literal["default", "custom"] | None
    dark_logo: bool = False


class LogoFile(BaseModel):
    media_type: Literal["image/svg+xml", "image/png"]
    content: bytes


DEFAULT_ORGANIZATION = Organization(name="Sundsvalls kommun", logo="default")
_LOGO_MAX_BYTES = 1024 * 1024


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
    upload_proxy_timeout_seconds: float = 1800.0
    # Övre gräns för modulsessionen. I eneo_sso-läge slutar den senast vid
    # Eneos sessionstak (module_auth_max_session_hours); modultoken förnyas
    # via Eneo fram till dess.
    session_max_age_seconds: int = 8 * 60 * 60
    # None shows "Tal till text" alone (SHOW_ORGANIZATION=false).
    organization: Organization | None = DEFAULT_ORGANIZATION
    organization_logo: LogoFile | None = None
    organization_logo_dark: LogoFile | None = None

    @property
    def flow_list_scope(self) -> FlowListScope | None:
        """The one place the auth mode decides how the flow list asks Eneo.

        An SSO user's list covers every space they belong to, so it never names
        one. The module key alone (access_code) must name its space; without
        DEMO_SPACE_ID there is nothing it may list.
        """
        if self.auth_mode == "eneo_sso":
            return FlowListScope(space_id=None)
        return FlowListScope(space_id=self.demo_space_id) if self.demo_space_id else None

    @property
    def module_origin(self) -> str:
        parsed = urlsplit(self.module_public_url)
        return f"{parsed.scheme}://{parsed.netloc}"


def _parse_bool(raw: str | None, *, default: bool, name: str) -> bool:
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"true", "1", "yes", "on"}:
        return True
    if normalized in {"false", "0", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be a boolean")


def _read_logo(variable: str, raw_path: str) -> LogoFile | None:
    """The logo file at ``raw_path`` if it is an SVG or a PNG, as its name says; otherwise logs why and gives None."""
    path = Path(raw_path)
    try:
        content = path.read_bytes()
    except OSError as error:
        logger.error("%s=%s cannot be read (%s); the organisation's name is shown instead.", variable, raw_path, error.strerror)
        return None
    head = content[:1024].lstrip(b"\xef\xbb\xbf \t\r\n")
    suffix = path.suffix.lower()
    if len(content) > _LOGO_MAX_BYTES:
        problem = "is larger than 1 MiB"
    elif suffix == ".png" and content.startswith(b"\x89PNG\r\n\x1a\n"):
        return LogoFile(media_type="image/png", content=content)
    elif suffix == ".svg" and head.startswith((b"<?xml", b"<svg", b"<!--", b"<!DOCTYPE")) and re.search(rb"<svg[\s>]", head):
        return LogoFile(media_type="image/svg+xml", content=content)
    else:
        problem = "is not an SVG or PNG file (by its name and its content)"
    logger.error("%s=%s %s; the organisation's name is shown instead.", variable, raw_path, problem)
    return None


def _organization() -> tuple[Organization | None, LogoFile | None, LogoFile | None]:
    """The organisation shown beside the product name, from ORGANIZATION_* and SHOW_ORGANIZATION.

    With none of them set it is Sundsvall with its bundled logo. A name alone is
    shown as text, never beside Sundsvall's logo. A logo that cannot be used is
    logged once at start and the name stands in for it.
    """
    if not _parse_bool(os.environ.get("SHOW_ORGANIZATION"), default=True, name="SHOW_ORGANIZATION"):
        return None, None, None
    name = " ".join((os.environ.get("ORGANIZATION_NAME") or "").split())
    logo_path = os.environ.get("ORGANIZATION_LOGO") or None
    dark_path = os.environ.get("ORGANIZATION_LOGO_DARK") or None
    if len(name) > 100:
        raise RuntimeError("ORGANIZATION_NAME must be at most 100 characters")
    if not name:
        if logo_path or dark_path:
            raise RuntimeError("ORGANIZATION_LOGO needs ORGANIZATION_NAME: the name is the logo's text alternative")
        return DEFAULT_ORGANIZATION, None, None
    logo = _read_logo("ORGANIZATION_LOGO", logo_path) if logo_path else None
    if logo is None:
        return Organization(name=name, logo=None), None, None
    dark = _read_logo("ORGANIZATION_LOGO_DARK", dark_path) if dark_path else None
    return Organization(name=name, logo="custom", dark_logo=dark is not None), logo, dark


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

    raw_session_minutes = os.environ.get("SESSION_MAX_AGE_MINUTES", "480")
    try:
        session_minutes = int(raw_session_minutes)
    except ValueError:
        raise RuntimeError("SESSION_MAX_AGE_MINUTES must be an integer") from None
    if session_minutes <= 0:
        raise RuntimeError("SESSION_MAX_AGE_MINUTES must be greater than zero")

    organization, organization_logo, organization_logo_dark = _organization()

    raw_access_code = os.environ.get("APP_ACCESS_CODE")
    if auth_mode == "eneo_sso" and raw_access_code:
        raise RuntimeError("APP_ACCESS_CODE may only be set with AUTH_MODE=access_code")
    if auth_mode == "access_code" and raw_access_code is not None:
        if not 16 <= len(raw_access_code) <= 256:
            raise RuntimeError("APP_ACCESS_CODE must be between 16 and 256 characters")

    settings = Settings(
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
        cookie_secure=_parse_bool(os.environ.get("COOKIE_SECURE"), default=True, name="COOKIE_SECURE"),
        demo_space_id=os.environ.get("DEMO_SPACE_ID") or None,
        upload_proxy_timeout_seconds=upload_timeout,
        session_max_age_seconds=session_minutes * 60,
        organization=organization,
        organization_logo=organization_logo,
        organization_logo_dark=organization_logo_dark,
    )
    if settings.flow_list_scope is None:
        logger.error(
            "AUTH_MODE=access_code needs DEMO_SPACE_ID: the module key lists flows only in "
            "the space it names. The flow list says it cannot be shown until it is set."
        )
    return settings
