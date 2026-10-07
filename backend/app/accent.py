"""The accent colour of a deployment (ORGANIZATION_ACCENT): checked against the design system's surfaces, completed
with its dark-mode and text colours, and rendered as the stylesheet GET /api/branding/theme.css serves.

Pure Python, standard library only: the accessibility gate's stub backend imports this module too.

The accent is also the colour of links, the focus ring and the selected tint, so it must be readable as text on the
page's surfaces: that is the one bar (4.5:1) it is held to. A configuration that cannot meet it refuses to start.
"""

from __future__ import annotations

import colorsys
import hashlib
import math
import re
from dataclasses import dataclass
from typing import NamedTuple

RGB = tuple[int, int, int]

MIN_CONTRAST = 4.5
# fullmatch, never `$`: that lets a trailing newline through.
_HEX = re.compile(r"#[0-9a-fA-F]{6}")
_NEUTRAL_ON_ACCENT = ("#FFFFFF", "#0B1118")


class _Mode(NamedTuple):
    name: str
    # The design system's page surfaces, its popover and secondary text (kit/theme/built/eneo.css), and how much of the
    # accent its muted tint (--color-accent-muted) mixes in.
    surfaces: tuple[str, ...]
    popover: str
    secondary_text: str
    tint: float


LIGHT = _Mode("ljust", ("#FBFCFF", "#F0F0F6"), "#FBFCFF", "#454650", 0.20)
DARK = _Mode("mörkt", ("#191C1F", "#0E1115"), "#2E3135", "#A5ACB6", 0.25)


def parse_hex(value: str) -> RGB | None:
    if not _HEX.fullmatch(value):
        return None
    return int(value[1:3], 16), int(value[3:5], 16), int(value[5:7], 16)


def to_hex(rgb: RGB) -> str:
    return "#%02X%02X%02X" % rgb


def _hex(value: str) -> RGB:
    rgb = parse_hex(value)
    assert rgb is not None, value
    return rgb


def luminance(rgb: RGB) -> float:
    r, g, b = ((c / 255 / 12.92) if c / 255 <= 0.04045 else ((c / 255 + 0.055) / 1.055) ** 2.4 for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: RGB, b: RGB) -> float:
    high, low = sorted((luminance(a), luminance(b)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def _blend(top: RGB, bottom: RGB, alpha: float) -> RGB:
    (tr, tg, tb), (br, bg, bb) = top, bottom
    return (round(tr * alpha + br * (1 - alpha)), round(tg * alpha + bg * (1 - alpha)), round(tb * alpha + bb * (1 - alpha)))


def _hls(rgb: RGB) -> tuple[float, float, float]:
    return colorsys.rgb_to_hls(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255)


def _from_hls(hue: float, lightness: float, saturation: float) -> RGB:
    r, g, b = colorsys.hls_to_rgb(hue, lightness, saturation)
    return round(r * 255), round(g * 255), round(b * 255)


def _on_accent(accent: RGB) -> RGB:
    """The text colour on the accent: the better of white and the theme's near-black."""
    return max((_hex(candidate) for candidate in _NEUTRAL_ON_ACCENT), key=lambda text: contrast(text, accent))


def _problem(accent: RGB, mode: _Mode) -> tuple[str, float, str] | None:
    """The first requirement ``accent`` fails in ``mode``: what is unreadable, its measured ratio, and what to do.

    The hover colour (a mix with 15 % black in light mode, white in dark) always moves toward the better text colour,
    so it needs no check of its own; the focus ring is the accent on the same surfaces.
    """
    surfaces = [_hex(surface) for surface in mode.surfaces]
    text_on = surfaces + [_hex(mode.popover)]
    lighter = "Välj en ljusare färg." if mode is DARK else "Välj en mörkare färg."
    checks = (
        ("texten på accentfärgen", contrast(_on_accent(accent), accent), lighter),
        ("accentfärgen mot sidans ytor", min(contrast(accent, surface) for surface in text_on), lighter),
        (
            "den sekundära texten på accentfärgens ton (valda rader)",
            min(contrast(_hex(mode.secondary_text), _blend(accent, surface, mode.tint)) for surface in surfaces),
            "Välj en mindre ljus färg." if mode is DARK else lighter,
        ),
    )
    return next(((what, ratio, advice) for what, ratio, advice in checks if ratio < MIN_CONTRAST), None)


def _swedish(ratio: float) -> str:
    """Two decimals, rounded down: 4.499 must not read as the 4,5 it fails to reach."""
    return f"{math.floor(ratio * 100) / 100:.2f}".replace(".", ",")


def _refusal(variable: str, value: str, mode: _Mode, problem: tuple[str, float, str]) -> RuntimeError:
    what, ratio, advice = problem
    return RuntimeError(
        f"{variable}={value}: {what} når {_swedish(ratio)}:1 i {mode.name} läge men måste nå minst "
        f"{_swedish(MIN_CONTRAST)}:1. {advice}"
    )


def _parse(variable: str, value: str) -> RGB:
    rgb = parse_hex(value)
    if rgb is None:
        raise RuntimeError(f"{variable} måste vara en färg på formen #RRGGBB, till exempel #1E7B34 (fick {value!r})")
    return rgb


def _derive_dark(light: RGB) -> RGB | None:
    """The light accent's hue and saturation at the lowest lightness that meets the dark mode's requirements."""
    hue, lightness, saturation = _hls(light)
    for half_percent in range(math.ceil(lightness * 200), 201):
        candidate = _from_hls(hue, half_percent / 200, saturation)
        if _problem(candidate, DARK) is None:
            return candidate
    return None


@dataclass(frozen=True)
class Accent:
    """A validated accent: the colour per mode and the text colour on it, each as #RRGGBB."""

    light: str
    dark: str
    on_light: str
    on_dark: str

    def __post_init__(self) -> None:
        for value in (self.light, self.dark, self.on_light, self.on_dark):
            if not _HEX.fullmatch(value):
                raise ValueError(f"not a #RRGGBB colour: {value!r}")


def resolve_accent(light: str | None, dark: str | None) -> Accent | None:
    """The accent from ORGANIZATION_ACCENT and ORGANIZATION_ACCENT_DARK (None when none is set).

    Raises RuntimeError, with the one Swedish sentence the operator needs, for a colour that is not #RRGGBB or that
    does not meet the contrast it is used at. A dark accent that is left out is derived from the light one.
    """
    if not light:
        if dark:
            raise RuntimeError("ORGANIZATION_ACCENT_DARK kräver ORGANIZATION_ACCENT: den mörka färgen hör till en ljus.")
        return None
    light_rgb = _parse("ORGANIZATION_ACCENT", light)
    if problem := _problem(light_rgb, LIGHT):
        raise _refusal("ORGANIZATION_ACCENT", light, LIGHT, problem)
    if dark:
        dark_rgb = _parse("ORGANIZATION_ACCENT_DARK", dark)
        if problem := _problem(dark_rgb, DARK):
            raise _refusal("ORGANIZATION_ACCENT_DARK", dark, DARK, problem)
    else:
        dark_rgb = _derive_dark(light_rgb)
        if dark_rgb is None:
            raise RuntimeError(
                f"ORGANIZATION_ACCENT={light}: ingen mörk variant av färgen går att härleda som når kraven i mörkt läge. "
                "Ange ORGANIZATION_ACCENT_DARK."
            )
    return Accent(
        light=to_hex(light_rgb),
        dark=to_hex(dark_rgb),
        on_light=to_hex(_on_accent(light_rgb)),
        on_dark=to_hex(_on_accent(dark_rgb)),
    )


NO_ACCENT_CSS = "/* Ingen ORGANIZATION_ACCENT är satt: modulens standardfärg gäller. */\n"


def theme_css(accent: Accent | None) -> str:
    """The stylesheet that overrides the built theme's accent. Only an ``Accent`` (already checked) is formatted."""
    if accent is None:
        return NO_ACCENT_CSS
    return (
        f"/* Organisationens accentfärg: {accent.light}, mörkt läge {accent.dark}. Skapad av modulens backend. */\n"
        # The design system's tokens, on its theme root. Unlayered, so it wins over the layered built theme. The
        # hover, muted and text-accent colours and the focus ring are all `var(--color-accent)` or a mix of it.
        '[data-astryx-theme="eneo"] {\n'
        f"  --color-accent: light-dark({accent.light}, {accent.dark});\n"
        f"  --color-on-accent: light-dark({accent.on_light}, {accent.on_dark});\n"
        "}\n"
    )


def etag(css: str) -> str:
    return '"' + hashlib.sha256(css.encode()).hexdigest()[:16] + '"'
