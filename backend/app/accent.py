"""The accent colour of a deployment (ORGANIZATION_ACCENT): checked against the design system's surfaces, completed
with its dark-mode and text colours, and rendered as the stylesheet GET /api/branding/theme.css serves.

Pure Python, standard library only: the accessibility gate's stub backend imports this module too.

The accent is also the colour of links, the focus ring and the selected tint, so it must be readable as text on the
page's surfaces: that is the one bar (4.5:1) it is held to. A configuration that cannot meet it refuses to start.

The theme's greys carry Eneo's blue. A deployment's accent tints them with its own hue instead, so a green accent has
green greys: nothing on the page keeps Eneo's blue.
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
    # Which colour of the theme's light-dark() pairs is this mode's: 0 the light one, 1 the dark one.
    side: int
    # How much of the accent its muted tint (--color-accent-muted) mixes in.
    tint: float


LIGHT = _Mode("ljust", 0, 0.10)
DARK = _Mode("mörkt", 1, 0.16)

# Eneo's own accent, light then dark (kit/theme/eneo.theme.ts ACCENT): the hue the theme's greys are tinted with.
ENEO_ACCENT = ("#1563BC", "#52B1FF")
# The theme's error colour, light then dark (--color-error). An accent near it makes a button, a link and the focus ring
# look like an error: allowed, but warned about. Near is a distance in OKLab, where about 0.02 is just noticeable.
ERROR = ("#AA181D", "#F47B7F")
_NEAR_ERROR = 0.1

# The theme's neutral colours exactly as the built theme (kit/theme/built/eneo.css) and the module's stylesheet
# (styles/globals.css) declare them: greys, and shadows, with Eneo's blue in them. theme_css gives each the accent's hue.
NEUTRALS: tuple[tuple[str, str], ...] = (
    ("--color-background-body", "light-dark(#F4F7FB, #070C16)"),
    ("--color-background-surface", "light-dark(#FFFFFF, #0B1322)"),
    ("--color-background-card", "light-dark(#FFFFFF, #0F1828)"),
    ("--color-background-popover", "light-dark(#FFFFFF, #16213A)"),
    ("--color-background-muted", "light-dark(#EEF2F8, #16213A)"),
    ("--color-background-inverted", "light-dark(#141A26, #E4E9F0)"),
    ("--color-text-primary", "light-dark(#141A26, #E4E9F0)"),
    ("--color-text-secondary", "light-dark(#4F5A6B, #9AA8BC)"),
    ("--color-text-disabled", "light-dark(#98A1AF, #56637A)"),
    ("--color-icon-primary", "light-dark(#141A26, #E4E9F0)"),
    ("--color-icon-secondary", "light-dark(#4F5A6B, #9AA8BC)"),
    ("--color-icon-disabled", "light-dark(#98A1AF, #56637A)"),
    ("--color-border", "light-dark(rgba(20, 40, 80, 0.08), rgba(255, 255, 255, 0.07))"),
    ("--color-border-emphasized", "light-dark(#758093, #6E7E96)"),
    ("--color-neutral", "light-dark(rgba(20, 40, 80, 0.07), rgba(255, 255, 255, 0.08))"),
    ("--color-overlay", "light-dark(rgba(15, 18, 23, 0.4), rgba(0, 0, 0, 0.6))"),
    ("--color-overlay-hover", "light-dark(rgba(20, 40, 80, 0.045), rgba(255, 255, 255, 0.05))"),
    ("--color-overlay-pressed", "light-dark(rgba(20, 40, 80, 0.09), rgba(255, 255, 255, 0.1))"),
    ("--color-skeleton", "light-dark(#E6E9EE, #242A32)"),
    ("--color-track", "light-dark(#DDE1E7, #2C323B)"),
    (
        "--shadow-low",
        "0 1px 2px light-dark(rgba(16, 40, 80, 0.04), transparent), "
        "0 6px 20px -6px light-dark(rgba(16, 40, 80, 0.08), transparent)",
    ),
    (
        "--shadow-med",
        "0 2px 4px light-dark(rgba(16, 40, 80, 0.05), transparent), "
        "0 16px 40px -12px light-dark(rgba(16, 40, 80, 0.12), transparent), "
        "inset 0 0 0 1px light-dark(transparent, rgba(255, 255, 255, 0.07))",
    ),
    ("--module-shadow-dock", "0 -8px 24px -16px light-dark(rgba(16, 40, 80, 0.18), transparent)"),
)
# The transcript's speaker colours, light then dark, as the module's stylesheet declares them (styles/globals.css
# --module-speaker-N). None is Eneo's blue, so a name does not read as a link; another accent can be one of them.
SPEAKERS: tuple[tuple[str, str], ...] = (
    ("#6D46B8", "#B69FE7"),
    ("#0B6E69", "#70CDC4"),
    ("#94590A", "#E8B775"),
    ("#B03A5B", "#E99DB6"),
    ("#1E7A32", "#7CBF8B"),
    ("#5D6827", "#B9C57E"),
)
# A speaker in the accent's hue is given one of these instead, the first not in that hue: a magenta, then a yellow
# green, each at least _SPEAKER_APART from every speaker above and neither blue (a deployment's page shows none).
SPARE_SPEAKERS: tuple[tuple[str, str], ...] = (("#993399", "#E198E1"), ("#2B6E0C", "#7EC25E"))
# Nearer in hue than this, in degrees, a speaker's name reads as the accent: a link, the focus ring, the selected chip.
# Eneo's own palette keeps its nearest speaker, the teal, 33 degrees from Eneo's blue.
_SPEAKER_APART = 30
# What the page is read on: each surface, the body last.
_GROUNDS = (
    "--color-background-surface",
    "--color-background-card",
    "--color-background-popover",
    "--color-background-muted",
    "--color-background-body",
)
# The greys that are read or seen, and the contrast each keeps on every ground: secondary text and its icons 4.5:1, a
# control's edge 3:1 (WCAG 1.4.11).
_DUTIES = {"--color-text-secondary": MIN_CONTRAST, "--color-icon-secondary": MIN_CONTRAST, "--color-border-emphasized": 3.0}
_COLOUR = r"#[0-9A-F]{6}|rgba\(\d+, \d+, \d+, [\d.]+\)|transparent"
_PAIR = re.compile(rf"light-dark\(({_COLOUR}), ({_COLOUR})\)")


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


def _linear(channel: int) -> float:
    c = channel / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb: RGB) -> float:
    r, g, b = (_linear(c) for c in rgb)
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


def _oklab(rgb: RGB) -> tuple[float, float, float]:
    """OKLab (Björn Ottosson's): a colour's lightness and its hue and chroma as the eye sees them."""
    r, g, b = (_linear(c) for c in rgb)
    l, m, s = (
        (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3),
        (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3),
        (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3),
    )
    return (
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    )


def _from_oklab(lab: tuple[float, float, float]) -> RGB:
    lightness, a, b = lab
    l, m, s = (
        (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3,
        (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3,
        (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3,
    )
    linear = (
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    )
    gamma = lambda c: 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055  # noqa: E731
    r, g, b = (round(255 * gamma(min(1.0, max(0.0, c)))) for c in linear)
    return r, g, b


def _retint(rgb: RGB, accent: RGB, mode: _Mode) -> RGB:
    """One of the theme's greys in the accent's hue instead of Eneo's: its lightness kept, its hue turned as far as the
    accent's is from Eneo's, its chroma in proportion to the accent's (up to Eneo's), so a grey accent leaves a grey.

    A dark navy grey keeps its chroma as a calm blue, but turned to red, orange or green the same chroma reads as brown or
    olive: in dark mode the chroma falls with the turn, to under half of it from 60 degrees away from Eneo's blue."""
    lightness, a, b = _oklab(rgb)
    _, ea, eb = _oklab(_hex(ENEO_ACCENT[mode.side]))
    _, aa, ab = _oklab(accent)
    turn = math.atan2(ab, aa) - math.atan2(eb, ea)
    scale = min(1.0, math.hypot(aa, ab) / math.hypot(ea, eb))
    if mode.side:
        scale *= 1 - 0.55 * min(1.0, abs(math.remainder(turn, math.tau)) / (math.pi / 3))
    cos, sin = scale * math.cos(turn), scale * math.sin(turn)
    return _from_oklab((lightness, a * cos - b * sin, a * sin + b * cos))


def _retinted(colour: str, accent: RGB, mode: _Mode) -> str:
    """A colour as NEUTRALS writes it (#RRGGBB, rgba() or transparent), in the accent's hue, written the same way."""
    if colour.startswith("#"):
        return to_hex(_retint(_hex(colour), accent, mode))
    if colour.startswith("rgba("):
        r, g, b, alpha = colour[5:-1].split(", ")
        return "rgba(%d, %d, %d, %s)" % (*_retint((int(r), int(g), int(b)), accent, mode), alpha)
    return colour


def _reaching(rgb: RGB, grounds: list[RGB], ratio: float, mode: _Mode) -> RGB:
    """`rgb`, darker in light mode and lighter in dark mode, step by step, until it reaches `ratio` on every ground."""
    lightness, a, b = _oklab(rgb)
    step = 0.005 if mode.side else -0.005
    while min(contrast(rgb, ground) for ground in grounds) < ratio and 0 < lightness < 1:
        lightness += step
        rgb = _from_oklab((lightness, a, b))
    return rgb


def _neutrals(accent: RGB, mode: _Mode) -> dict[str, RGB]:
    """The theme's solid greys in ``mode`` for ``accent``: in its hue, and those with a duty reaching their contrast on
    every ground."""
    neutrals = {
        token: _retint(_hex(pair[1 + mode.side]), accent, mode)
        for token, value in NEUTRALS
        if (pair := _PAIR.fullmatch(value)) and pair[1].startswith("#")
    }
    grounds = [neutrals[token] for token in _GROUNDS]
    for token, ratio in _DUTIES.items():
        neutrals[token] = _reaching(neutrals[token], grounds, ratio, mode)
    return neutrals


def _on_accent(accent: RGB) -> RGB:
    """The text colour on the accent: the better of white and the theme's near-black."""
    return max((_hex(candidate) for candidate in _NEUTRAL_ON_ACCENT), key=lambda text: contrast(text, accent))


def _problem(accent: RGB, mode: _Mode) -> tuple[str, float, str] | None:
    """The first requirement ``accent`` fails in ``mode``: what is unreadable, its measured ratio, and what to do.

    The page is the theme's greys in the accent's own hue (_neutrals). The hover colour (a mix with 15 % black in light
    mode, white in dark) always moves toward the better text colour, so it needs no check of its own; the focus ring is
    the accent on the same surfaces.
    """
    neutrals = _neutrals(accent, mode)
    surfaces = [neutrals[token] for token in ("--color-background-surface", "--color-background-card", "--color-background-body")]
    text_on = surfaces + [neutrals["--color-background-popover"]]
    lighter = "Välj en ljusare färg." if mode.side else "Välj en mörkare färg."
    checks = (
        ("texten på accentfärgen", contrast(_on_accent(accent), accent), lighter),
        ("accentfärgen mot sidans ytor", min(contrast(accent, surface) for surface in text_on), lighter),
        (
            "den sekundära texten på accentfärgens ton (valda rader)",
            min(contrast(neutrals["--color-text-secondary"], _blend(accent, surface, mode.tint)) for surface in surfaces),
            "Välj en mindre ljus färg." if mode.side else lighter,
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
        raise RuntimeError(f"{variable} måste vara en färg på formen #RRGGBB, till exempel #1C7531 (fick {value!r})")
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


def accent_warning(accent: Accent) -> str | None:
    """The one Swedish sentence to log, not a refusal, for an accent near the error colour in either mode."""
    for mode, colour in ((LIGHT, accent.light), (DARK, accent.dark)):
        if math.dist(_oklab(_hex(colour)), _oklab(_hex(ERROR[mode.side]))) < _NEAR_ERROR:
            return (
                f"ORGANIZATION_ACCENT={accent.light}: accentfärgen ligger nära felfärgen i {mode.name} läge ({colour}), så "
                "knappar och länkar kan läsas som fel. Välj en färg längre från rött."
            )
    return None


NO_ACCENT_CSS = "/* Ingen ORGANIZATION_ACCENT är satt: modulens standardfärg gäller. */\n"


def _hued(accent: Accent) -> list[tuple[str, str]]:
    """NEUTRALS in the accent's hue, each mode's colour of a pair in that mode's accent."""
    light, dark = _hex(accent.light), _hex(accent.dark)
    solid = (_neutrals(light, LIGHT), _neutrals(dark, DARK))
    hued = []
    for token, value in NEUTRALS:
        if token in _DUTIES:
            value = f"light-dark({to_hex(solid[0][token])}, {to_hex(solid[1][token])})"
        else:
            value = _PAIR.sub(lambda pair: f"light-dark({_retinted(pair[1], light, LIGHT)}, {_retinted(pair[2], dark, DARK)})", value)
        hued.append((token, value))
    return hued


def _hue_apart(one: RGB, other: RGB) -> float:
    """How far apart two colours are in hue, in degrees; a grey has no hue, so it is apart from every colour."""
    if max(one) - min(one) < 26 or max(other) - min(other) < 26:
        return 180.0
    turn = abs(_hls(one)[0] - _hls(other)[0]) * 360
    return min(turn, 360 - turn)


def _speakers(accent: Accent) -> list[tuple[str, str]]:
    """The speakers whose colour this accent changes: one in the accent's hue in either mode takes a spare's place, and
    each keeps 4.5:1 on every ground of its mode and on the selected passage's tint, as the module's own do on Eneo's."""
    accents = (_hex(accent.light), _hex(accent.dark))
    near = lambda pair: any(_hue_apart(_hex(pair[side]), accents[side]) < _SPEAKER_APART for side in (0, 1))  # noqa: E731
    grounds = []
    for mode in (LIGHT, DARK):
        neutrals = _neutrals(accents[mode.side], mode)
        tints = [_blend(accents[mode.side], neutrals[token], mode.tint) for token in ("--color-background-surface", "--color-background-card")]
        grounds.append([neutrals[token] for token in _GROUNDS] + tints)
    spares = iter(pair for pair in SPARE_SPEAKERS if not near(pair))
    changed = []
    for index, pair in enumerate(SPEAKERS):
        chosen = next(spares, pair) if near(pair) else pair
        light, dark = (to_hex(_reaching(_hex(chosen[mode.side]), grounds[mode.side], MIN_CONTRAST, mode)) for mode in (LIGHT, DARK))
        if (light, dark) != pair:
            changed.append((f"--module-speaker-{index}", f"light-dark({light}, {dark})"))
    return changed


def theme_css(accent: Accent | None) -> str:
    """The stylesheet that overrides the built theme's accent, and its greys with the accent's hue. Only an ``Accent``
    (already checked) is formatted."""
    if accent is None:
        return NO_ACCENT_CSS
    return (
        f"/* Organisationens accentfärg: {accent.light}, mörkt läge {accent.dark}. Skapad av modulens backend. */\n"
        # The design system's tokens, on its theme root. Unlayered, so it wins over the layered built theme. The
        # hover, muted and text-accent colours and the focus ring are all `var(--color-accent)` or a mix of it.
        '[data-astryx-theme="eneo"] {\n'
        f"  --color-accent: light-dark({accent.light}, {accent.dark});\n"
        f"  --color-on-accent: light-dark({accent.on_light}, {accent.on_dark});\n"
        + "".join(f"  {token}: {value};\n" for token, value in _hued(accent) + _speakers(accent))
        + "}\n"
    )


def etag(css: str) -> str:
    return '"' + hashlib.sha256(css.encode()).hexdigest()[:16] + '"'
