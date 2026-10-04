from __future__ import annotations

import logging
import math
import os
import re
import struct
from pathlib import Path
from typing import Literal, Self
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, model_validator

from app.accent import Accent, resolve_accent


logger = logging.getLogger("eneo_config")


class LogoSize(BaseModel):
    """A logo's proportions: the page gives its <img> this width and height, so the header does not move when the file arrives."""

    width: int = Field(gt=0)
    height: int = Field(gt=0)


class LogoSizes(BaseModel):
    light: LogoSize
    dark: LogoSize | None = None


class Organization(BaseModel):
    """The organisation beside "Tal till text": its name, and its logo.

    ``logo`` is ``default`` for Sundsvall's bundled logo, ``custom`` for the
    deployment's own (served by /api/branding/logo/{light,dark}), or None for
    the name as text. A custom logo has its size, and so has its dark one when
    there is one: the page cannot reserve room for a file it knows nothing of.
    """

    name: str
    logo: Literal["default", "custom"] | None
    dark_logo: bool = False
    logo_sizes: LogoSizes | None = None

    @model_validator(mode="after")
    def _the_sizes_are_those_of_the_logos(self) -> Self:
        sizes = self.logo_sizes
        if self.logo == "custom":
            if sizes is None or (sizes.dark is not None) != self.dark_logo:
                raise ValueError("a custom logo has a size, and its dark logo has one exactly when there is a dark logo")
        elif sizes is not None or self.dark_logo:
            raise ValueError("only a custom logo has a size or a dark logo")
        return self


class LogoFile(BaseModel):
    media_type: Literal["image/svg+xml", "image/png"]
    content: bytes


DEFAULT_ORGANIZATION = Organization(name="Sundsvalls kommun", logo="default")
_LOGO_MAX_BYTES = 1024 * 1024


class Settings(BaseModel):
    eneo_backend_url: str
    eneo_public_url: str
    module_public_url: str
    module_key: str
    eneo_api_key: str
    eneo_api_key_header_name: str = "X-API-Key"
    session_secret: str
    cookie_secure: bool = True
    upload_proxy_timeout_seconds: float = 1800.0
    # No request body is read past max_body_bytes; only an upload's is read up to max_upload_bytes (app/limits.py).
    max_body_bytes: int = 10 * 1024 * 1024
    max_upload_bytes: int = 1024 * 1024 * 1024
    # The most the module reads of one answer from Eneo (app/upstream.py); a file that streams to the browser is not counted.
    max_response_bytes: int = 32 * 1024 * 1024
    # The folder with the built UI, which the backend serves last (app/web.py); unset serves no page (a launch with
    # --api-only, the tests). The launcher refuses to start without it unless it is told not to serve the UI.
    static_dir: Path | None = None
    # Övre gräns för modulsessionen. Den slutar senast vid Eneos sessionstak
    # (module_auth_max_session_hours); modultoken förnyas via Eneo fram till dess.
    session_max_age_seconds: int = 8 * 60 * 60
    # None shows "Tal till text" alone (SHOW_ORGANIZATION=false).
    organization: Organization | None = DEFAULT_ORGANIZATION
    organization_logo: LogoFile | None = None
    organization_logo_dark: LogoFile | None = None
    # None keeps the theme's own accent (Sundsvall's blue): GET /api/branding/theme.css is then an empty stylesheet.
    accent: Accent | None = None

    @property
    def module_origin(self) -> str:
        parsed = urlsplit(self.module_public_url)
        return f"{parsed.scheme}://{parsed.netloc}"


def _default(field: str):
    """What ``Settings`` gives ``field`` when nothing sets it: the one place a default is written."""
    return Settings.model_fields[field].default


def _parse_bool(raw: str | None, *, default: bool, name: str) -> bool:
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"true", "1", "yes", "on"}:
        return True
    if normalized in {"false", "0", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be a boolean")


# Headers the module sets from the session or the request itself: the bearer token owns Authorization, and the key
# in any of these would replace it or break the request's framing.
_RESERVED_HEADER_NAMES = frozenset(
    {
        "authorization",
        "proxy-authorization",
        "cookie",
        "origin",
        "referer",
        "host",
        "content-length",
        "content-type",
        "transfer-encoding",
        "connection",
        "keep-alive",
        "te",
        "trailer",
        "upgrade",
    }
)


# No limit of the module is meant to be larger than this: a value past it is a typo, and one that is huge enough
# is no limit at all.
_MAX_BYTES = 2**40  # 1 TiB
_MAX_SECONDS = 24 * 60 * 60


def _positive_int(name: str, default: int, *, maximum: int = _MAX_BYTES) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:  # not a number, or one of more digits than int() takes
        value = 0
    if not 0 < value <= maximum:
        raise RuntimeError(f"{name} must be an integer between 1 and {maximum}")
    return value


def _positive_seconds(name: str, default: float) -> float:
    """A finite number of seconds greater than zero, at most a day: ``inf`` or ``nan`` would be no deadline at all."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        value = 0.0
    if not (math.isfinite(value) and 0 < value <= _MAX_SECONDS):
        raise RuntimeError(f"{name} must be a number of seconds greater than zero and at most {_MAX_SECONDS}")
    return value


_SVG_ROOT = re.compile(rb"<svg\b((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>")
_ATTRIBUTE = re.compile(rb"([\w:.-]+)\s*=\s*(?:\"([^\"]*)\"|'([^']*)')")
_LENGTH = re.compile(rb"\s*((?:\d+\.?\d*|\.\d+))(?:px)?\s*")  # an absolute length; a percentage or an em says nothing
_BOX_SIDE = 100_000


def _positive(value: float) -> float | None:
    return value if math.isfinite(value) and value > 0 else None


def _svg_proportions(content: bytes) -> tuple[float, float] | None:
    """What an <img> shows an SVG's root as: its width and height when both are plain lengths, else its viewBox's."""
    root = _SVG_ROOT.search(re.sub(rb"<!--.*?-->", b"", content[:8192], flags=re.DOTALL))
    if root is None:
        return None
    attributes = {name: double or single for name, double, single in _ATTRIBUTE.findall(root.group(1))}

    def length(name: bytes) -> float | None:
        found = _LENGTH.fullmatch(attributes.get(name, b""))
        return _positive(float(found.group(1))) if found else None

    box = None
    parts = re.split(rb"[\s,]+", attributes.get(b"viewBox", b"").strip())
    if len(parts) == 4:
        try:
            box = (_positive(float(parts[2])), _positive(float(parts[3])))
        except ValueError:
            pass
    width, height = length(b"width"), length(b"height")
    if width and height:
        return width, height
    if box and box[0] and box[1]:
        if width:
            return width, width * box[1] / box[0]
        if height:
            return height * box[0] / box[1], height
        return box[0], box[1]
    return None


def _png_proportions(content: bytes) -> tuple[float, float] | None:
    """The width and height in the PNG's header (IHDR, always the first chunk)."""
    if len(content) < 24 or content[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", content[16:24])
    return (width, height) if width and height else None


def _logo_size(media_type: str, content: bytes) -> LogoSize | None:
    """The proportions as whole numbers: as they are when they are, else the longer side 1000, which keeps them to 0.05 %."""
    found = _png_proportions(content) if media_type == "image/png" else _svg_proportions(content)
    if found is None:
        return None
    width, height = found
    if width != int(width) or height != int(height) or max(width, height) > _BOX_SIDE:
        scale = 1000 / max(width, height)
        width, height = max(1, round(width * scale)), max(1, round(height * scale))
    return LogoSize(width=int(width), height=int(height))


def _read_logo(variable: str, raw_path: str) -> tuple[LogoFile, LogoSize] | None:
    """The logo file at ``raw_path`` and its size, if it is an SVG or a PNG, as its name says and with a size the page can
    use; otherwise logs why and gives None."""
    path = Path(raw_path)
    try:
        # Read at most one byte past the limit, so a large file mounted by mistake is never loaded whole.
        with path.open("rb") as file:
            content = file.read(_LOGO_MAX_BYTES + 1)
    except OSError as error:
        logger.error("%s=%s cannot be read (%s); the organisation's name is shown instead.", variable, raw_path, error.strerror)
        return None
    head = content[:1024].lstrip(b"\xef\xbb\xbf \t\r\n")
    suffix = path.suffix.lower()
    media_type: Literal["image/svg+xml", "image/png"] | None = None
    if len(content) > _LOGO_MAX_BYTES:
        problem = "is larger than 1 MiB"
    elif suffix == ".png" and content.startswith(b"\x89PNG\r\n\x1a\n"):
        media_type = "image/png"
    elif suffix == ".svg" and head.startswith((b"<?xml", b"<svg", b"<!--", b"<!DOCTYPE")) and re.search(rb"<svg[\s>]", head):
        media_type = "image/svg+xml"
    else:
        problem = "is not an SVG or PNG file (by its name and its content)"
    if media_type is not None:
        size = _logo_size(media_type, content)
        if size is not None:
            return LogoFile(media_type=media_type, content=content), size
        problem = "has no size the page can use (an SVG needs a viewBox, or a width and a height in px; a PNG a readable header)"
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
    light = _read_logo("ORGANIZATION_LOGO", logo_path) if logo_path else None
    if light is None:
        return Organization(name=name, logo=None), None, None
    dark = _read_logo("ORGANIZATION_LOGO_DARK", dark_path) if dark_path else None
    sizes = LogoSizes(light=light[1], dark=dark[1] if dark else None)
    return (
        Organization(name=name, logo="custom", dark_logo=dark is not None, logo_sizes=sizes),
        light[0],
        dark[0] if dark else None,
    )


def _accent() -> Accent | None:
    """The accent from ORGANIZATION_ACCENT and ORGANIZATION_ACCENT_DARK, apart from the organisation's name and logo."""
    light, dark = (os.environ.get(name, "").strip() for name in ("ORGANIZATION_ACCENT", "ORGANIZATION_ACCENT_DARK"))
    return resolve_accent(light, dark)


# The hosts that mean this machine, matched on the parsed host and nothing else: not a prefix, not a suffix, not what
# stands before an "@", and no other spelling of the same address.
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_LOOPBACK_SPELLING = "localhost, 127.0.0.1 or [::1]"


def _is_loopback(url: str) -> bool:
    return urlsplit(url).hostname in _LOOPBACK_HOSTS


def _required_url(name: str, *, public: bool = False) -> str:
    """The URL in ``name``. A ``public`` one is what a browser is sent to: https, except on this machine."""
    value = os.environ[name].rstrip("/")
    try:
        parsed = urlsplit(value)
    except ValueError:
        raise RuntimeError(f"{name} must be an absolute http(s) URL") from None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RuntimeError(f"{name} must be an absolute http(s) URL")
    if parsed.query or parsed.fragment:
        raise RuntimeError(f"{name} must not contain a query string or fragment")
    if public and parsed.scheme == "http" and not _is_loopback(value):
        raise RuntimeError(f"{name} must be an https URL: http is accepted only for {_LOOPBACK_SPELLING} (local development)")
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

    api_key_header_name = os.environ.get("ENEO_API_KEY_HEADER_NAME", _default("eneo_api_key_header_name"))
    if re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", api_key_header_name) is None:
        raise RuntimeError("ENEO_API_KEY_HEADER_NAME must be a valid HTTP header name")
    if api_key_header_name.lower() in _RESERVED_HEADER_NAMES:
        raise RuntimeError(
            "ENEO_API_KEY_HEADER_NAME cannot be a credential or framing header "
            f"({', '.join(sorted(_RESERVED_HEADER_NAMES))}): the module sets those itself"
        )

    upload_timeout = _positive_seconds("UPLOAD_PROXY_TIMEOUT_SECONDS", _default("upload_proxy_timeout_seconds"))

    raw_session_minutes = os.environ.get("SESSION_MAX_AGE_MINUTES", str(_default("session_max_age_seconds") // 60))
    try:
        session_minutes = int(raw_session_minutes)
    except ValueError:
        raise RuntimeError("SESSION_MAX_AGE_MINUTES must be an integer") from None
    if session_minutes <= 0:
        raise RuntimeError("SESSION_MAX_AGE_MINUTES must be greater than zero")

    organization, organization_logo, organization_logo_dark = _organization()
    accent = _accent()

    # The backend's own URL is on the service network, where http is how it is reached. The two a browser is sent to are not.
    module_public_url = _required_url("MODULE_PUBLIC_URL", public=True)
    cookie_secure = _parse_bool(os.environ.get("COOKIE_SECURE"), default=_default("cookie_secure"), name="COOKIE_SECURE")
    if not cookie_secure and not _is_loopback(module_public_url):
        raise RuntimeError(f"COOKIE_SECURE=false is accepted only when MODULE_PUBLIC_URL is {_LOOPBACK_SPELLING} (local development)")

    return Settings(
        eneo_backend_url=_required_url("ENEO_BACKEND_URL"),
        eneo_public_url=_required_url("ENEO_PUBLIC_URL", public=True),
        module_public_url=module_public_url,
        module_key=module_key,
        eneo_api_key=os.environ["ENEO_API_KEY"],
        eneo_api_key_header_name=api_key_header_name,
        session_secret=session_secret,
        cookie_secure=cookie_secure,
        upload_proxy_timeout_seconds=upload_timeout,
        max_body_bytes=_positive_int("MAX_BODY_BYTES", _default("max_body_bytes")),
        max_upload_bytes=_positive_int("MAX_UPLOAD_BYTES", _default("max_upload_bytes")),
        max_response_bytes=_positive_int("MAX_RESPONSE_BYTES", _default("max_response_bytes")),
        static_dir=Path(os.environ["STATIC_DIR"]) if os.environ.get("STATIC_DIR") else None,
        session_max_age_seconds=session_minutes * 60,
        organization=organization,
        organization_logo=organization_logo,
        organization_logo_dark=organization_logo_dark,
        accent=accent,
    )
