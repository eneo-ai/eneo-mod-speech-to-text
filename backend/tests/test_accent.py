import colorsys
import math
import re
import unittest
from pathlib import Path
from unittest.mock import patch

from app import accent as accent_module
from app.accent import (
    DARK,
    ENEO_ACCENT,
    ERROR,
    LIGHT,
    NEUTRALS,
    NO_ACCENT_CSS,
    Accent,
    _blend,
    _hex,
    _hued,
    _neutrals,
    _oklab,
    _problem,
    _swedish,
    contrast,
    etag,
    accent_warning,
    luminance,
    parse_hex,
    resolve_accent,
    theme_css,
)

GREEN = Accent(light="#1C7531", dark="#269E42", on_light="#FFFFFF", on_dark="#0B1118")
ENEO = Accent(light=ENEO_ACCENT[0], dark=ENEO_ACCENT[1], on_light="#FFFFFF", on_dark="#0B1118")
HOSTILE = [
    "#004595\n",
    " #004595",
    "#004595 ",
    "#00459",
    "#0045955",
    "004595",
    "#GGGGGG",
    "#004595}",
    "#004595;}body{display:none",
    "#004595</style><script>alert(1)</script>",
    "red",
    "url(https://example.test/x.css)",
    "#００４５９５",  # full-width digits
    "#00459٥",  # an Arabic-Indic digit, which \\d would take
    "",
]


class ContrastMathTests(unittest.TestCase):
    def test_wcag_reference_values(self) -> None:
        self.assertEqual(luminance((255, 255, 255)), 1.0)
        self.assertEqual(luminance((0, 0, 0)), 0.0)
        self.assertAlmostEqual(contrast((0, 0, 0), (255, 255, 255)), 21.0)
        # The best-known grey: the lightest that is 4.5:1 on white, 4.54 to two decimals.
        self.assertAlmostEqual(contrast(_hex("#767676"), (255, 255, 255)), 4.54, places=2)
        self.assertEqual(contrast(_hex("#123456"), _hex("#FEDCBA")), contrast(_hex("#FEDCBA"), _hex("#123456")))

    def test_a_ratio_that_falls_short_is_never_rounded_up_to_the_minimum(self) -> None:
        self.assertEqual(_swedish(4.499), "4,49")
        self.assertEqual(_swedish(4.5), "4,50")
        self.assertEqual(_swedish(21), "21,00")

    def test_the_themes_own_accent_meets_every_requirement(self) -> None:
        self.assertIsNone(_problem(_hex("#004595"), LIGHT))
        self.assertIsNone(_problem(_hex("#52B1FF"), DARK))

    def test_the_constants_are_the_built_themes(self) -> None:
        built = Path(__file__).resolve().parents[2] / "frontend" / "kit" / "theme" / "built" / "eneo.css"
        if not built.exists():
            self.skipTest("the frontend is not part of this checkout (the backend image)")
        css = built.read_text()
        globals_css = " ".join((built.parents[3] / "styles" / "globals.css").read_text().split())
        # Every grey as the theme or the module's stylesheet declares it, and Eneo's accent as the theme's.
        for token, value in NEUTRALS:
            self.assertIn(f"{token}: {value};", css if token.startswith(("--color", "--shadow")) else globals_css, token)
        self.assertIn(f"--color-accent: light-dark({ENEO_ACCENT[0]}, {ENEO_ACCENT[1]});", css)
        self.assertIn(f"--color-error: light-dark({ERROR[0]}, {ERROR[1]});", css)
        mix = lambda space, light, dark: (  # noqa: E731
            f"light-dark(color-mix(in {space}, var(--color-accent) {light:.0%}, transparent), "
            f"color-mix(in {space}, var(--color-accent) {dark:.0%}, transparent))"
        )
        self.assertIn(f"--color-accent-muted: {mix('srgb', LIGHT.tint, DARK.tint)}", css)
        # The wash at the page's head (styles/globals.css) is the one the accent is read on.
        self.assertIn(mix("oklab", LIGHT.wash, DARK.wash), globals_css)


class NeutralsTests(unittest.TestCase):
    """The theme's greys in a deployment's hue: green greys for a green accent, Eneo's own for Eneo's blue."""

    ACCENTS = ("#1C7531", "#B3261E", "#6B1EFD", "#00695C", "#5E6B00", "#0000FF", "#000000", "#004595", "#8A4B00", "#A0157A")

    @staticmethod
    def blue(rgb: tuple[int, int, int]) -> bool:
        """The branding gate's blue (frontend/tests/e2e/branding.spec.ts): saturated, its hue between 195 and 255."""
        high, low = max(rgb), min(rgb)
        if (high - low) / 255 < 0.1 or high != rgb[2]:
            return False
        return 195 <= 60 * (4 + (rgb[0] - rgb[1]) / (high - low)) <= 255

    def test_eneos_own_accent_keeps_the_themes_greys_exactly(self) -> None:
        self.assertEqual(_hued(ENEO), list(NEUTRALS))

    def test_a_deployments_greys_take_its_hue_and_keep_no_blue(self) -> None:
        # Hues well away from blue; a violet's greys are violet, and some of them blue enough for the gate's rule.
        for light in ("#1C7531", "#B3261E", "#5E6B00", "#8A4B00", "#A0157A", "#000000"):
            accent = resolve_accent(light, None)
            assert accent is not None, light
            css = theme_css(accent)
            colours = [tuple(int(c) for c in found) for found in re.findall(r"rgba\((\d+), (\d+), (\d+),", css)]
            colours += [_hex(found) for found in re.findall(r"#[0-9A-F]{6}", css.split("\n", 1)[1])]
            self.assertGreater(len(colours), 40, light)
            self.assertEqual([c for c in colours if self.blue(c)], [], light)

    def test_dark_grounds_in_a_hue_far_from_eneos_blue_stay_near_neutral(self) -> None:
        # A navy grey's chroma turned to red or green reads as brown or olive: the dark ground stays a grey there, and
        # keeps a little of a blue or violet accent's hue.
        grounds = ("--color-background-body", "--color-background-surface", "--color-background-card", "--color-background-popover")
        chroma = lambda rgb: math.hypot(*_oklab(rgb)[1:])  # noqa: E731
        for light, most in (("#B3261E", 0.025), ("#1C7531", 0.025), ("#8A4B00", 0.025), ("#004595", 0.06)):
            accent = resolve_accent(light, None)
            assert accent is not None, light
            neutrals = _neutrals(_hex(accent.dark), DARK)
            for token in grounds:
                self.assertLessEqual(chroma(neutrals[token]), most, (light, token, neutrals[token]))

    def test_a_grey_accent_leaves_plain_greys(self) -> None:
        for mode in (LIGHT, DARK):
            for token, rgb in _neutrals(_hex("#555555" if mode is LIGHT else "#AAAAAA"), mode).items():
                self.assertLessEqual(max(rgb) - min(rgb), 1, (mode.name, token, rgb))

    def test_what_is_read_or_seen_keeps_its_contrast_on_every_ground_in_any_hue(self) -> None:
        grounds = ("--color-background-surface", "--color-background-card", "--color-background-popover",
                   "--color-background-muted", "--module-color-background-sunken", "--color-background-body")
        for light in self.ACCENTS:
            accent = resolve_accent(light, None)
            assert accent is not None, light
            for mode, colour in ((LIGHT, accent.light), (DARK, accent.dark)):
                neutrals = _neutrals(_hex(colour), mode)
                on = [neutrals[token] for token in grounds] + [_blend(_hex(colour), neutrals["--color-background-body"], mode.wash)]
                for token, ratio in (("--color-text-secondary", 4.5), ("--color-text-primary", 4.5), ("--color-border-emphasized", 3.0)):
                    self.assertGreaterEqual(min(contrast(neutrals[token], ground) for ground in on), ratio, (light, mode.name, token))


class ResolveTests(unittest.TestCase):
    def test_nothing_set_is_no_accent(self) -> None:
        self.assertIsNone(resolve_accent(None, None))
        self.assertIsNone(resolve_accent("", ""))

    def test_a_dark_accent_that_is_left_out_is_derived_from_the_light_one(self) -> None:
        self.assertEqual(resolve_accent("#1C7531", None), GREEN)

    def test_a_given_dark_accent_is_used_as_it_is(self) -> None:
        accent = resolve_accent("#004595", "#52b1ff")
        assert accent is not None
        self.assertEqual((accent.light, accent.dark), ("#004595", "#52B1FF"))

    def test_the_derived_dark_accent_keeps_the_hue_and_meets_the_dark_mode(self) -> None:
        for light in ("#1C7531", "#B3261E", "#6B1EFD", "#00695C", "#5E6B00", "#0000FF", "#000000"):
            accent = resolve_accent(light, None)
            assert accent is not None, light
            self.assertIsNone(_problem(_hex(accent.dark), DARK), light)
            hue = lambda value: colorsys.rgb_to_hls(*(c / 255 for c in _hex(value)))[0]  # noqa: E731
            if light != "#000000":  # no hue to keep
                self.assertLess(abs(hue(accent.dark) - hue(light)), 0.01, light)
            self.assertGreater(luminance(_hex(accent.dark)), luminance(_hex(light)), light)

    def test_the_text_on_the_accent_is_the_better_of_white_and_the_themes_near_black(self) -> None:
        accent = resolve_accent("#1C7531", None)
        assert accent is not None
        self.assertEqual((accent.on_light, accent.on_dark), ("#FFFFFF", "#0B1118"))

    def test_a_colour_that_is_not_rrggbb_is_refused_for_its_form(self) -> None:
        with self.assertRaisesRegex(RuntimeError, r"ORGANIZATION_ACCENT måste vara en färg på formen #RRGGBB.*'blue'"):
            resolve_accent("blue", None)
        with self.assertRaisesRegex(RuntimeError, r"ORGANIZATION_ACCENT_DARK måste vara en färg på formen #RRGGBB"):
            resolve_accent("#1C7531", "#fff")

    def test_each_refusal_names_the_measured_ratio_and_the_minimum(self) -> None:
        cases = [
            (("#FFD700", None), "ORGANIZATION_ACCENT=#FFD700: accentfärgen mot sidans ytor når 1,26:1 i ljust läge men måste nå minst 4,50:1. Välj en mörkare färg."),
            (("#767676", None), "ORGANIZATION_ACCENT=#767676: accentfärgen mot sidans ytor når 3,77:1 i ljust läge men måste nå minst 4,50:1. Välj en mörkare färg."),
            (("#004595", "#004595"), "ORGANIZATION_ACCENT_DARK=#004595: accentfärgen mot sidans ytor når 1,74:1 i mörkt läge men måste nå minst 4,50:1. Välj en ljusare färg."),
        ]
        for arguments, message in cases:
            with self.assertRaises(RuntimeError) as raised:
                resolve_accent(*arguments)
            self.assertEqual(str(raised.exception), message)

    def test_a_dark_accent_too_bright_for_selected_rows_says_so(self) -> None:
        # The theme's 16 % tint leaves the secondary text readable on any accent that passes the other two checks; at a
        # quarter, white would not be.
        self.assertIsNone(_problem(_hex("#FFFFFF"), DARK))
        with patch.object(accent_module, "DARK", DARK._replace(tint=0.25)):
            with self.assertRaisesRegex(RuntimeError, r"ORGANIZATION_ACCENT_DARK=#FFFFFF: den sekundära texten på accentfärgens ton \(valda rader\) når 3,\d\d:1 i mörkt läge men måste nå minst 4,50:1\. Välj en mindre ljus färg\."):
                resolve_accent("#004595", "#FFFFFF")

    def test_a_dark_accent_without_a_light_one_is_refused(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "ORGANIZATION_ACCENT_DARK kräver ORGANIZATION_ACCENT"):
            resolve_accent(None, "#52B1FF")

    def test_hostile_values_are_refused_before_anything_is_formatted(self) -> None:
        for value in HOSTILE[:-1]:
            self.assertIsNone(parse_hex(value), repr(value))
            for arguments in ((value, None), ("#004595", value)):
                with self.assertRaises(RuntimeError, msg=repr(arguments)):
                    resolve_accent(*arguments)
            with self.assertRaises(ValueError, msg=repr(value)):
                Accent(light=value, dark="#52B1FF", on_light="#FFFFFF", on_dark="#0B1118")
            with self.assertRaises(ValueError, msg=repr(value)):
                Accent(light="#004595", dark="#52B1FF", on_light="#FFFFFF", on_dark=value)


class WarningTests(unittest.TestCase):
    def test_an_accent_that_errors_would_be_mistaken_for_is_warned_about_but_allowed(self) -> None:
        red = resolve_accent("#B3261E", None)
        assert red is not None
        warning = accent_warning(red)
        assert warning is not None
        self.assertRegex(warning, r"^ORGANIZATION_ACCENT=#B3261E: accentfärgen ligger nära felfärgen")
        for light in ("#1C7531", "#004595", "#6B1EFD"):
            accent = resolve_accent(light, None)
            assert accent is not None, light
            self.assertIsNone(accent_warning(accent), light)


class ThemeCssTests(unittest.TestCase):
    def test_no_accent_is_a_harmless_comment(self) -> None:
        self.assertEqual(theme_css(None), NO_ACCENT_CSS)
        self.assertRegex(NO_ACCENT_CSS, r"\A/\*[^{}]*\*/\n\Z")

    def test_the_stylesheet_is_the_accent_and_the_greys_in_its_hue(self) -> None:
        css = theme_css(GREEN)
        self.assertTrue(
            css.startswith(
                "/* Organisationens accentfärg: #1C7531, mörkt läge #269E42. Skapad av modulens backend. */\n"
                '[data-astryx-theme="eneo"] {\n'
                "  --color-accent: light-dark(#1C7531, #269E42);\n"
                "  --color-on-accent: light-dark(#FFFFFF, #0B1118);\n"
            ),
            css,
        )
        self.assertTrue(css.endswith("}\n"))
        self.assertEqual([line.split(":")[0].strip() for line in css.splitlines()[4:-1]], [token for token, _ in NEUTRALS])
        self.assertIn("  --color-text-secondary: light-dark(#4F5E52, #A0AAA3);\n", css)

    def test_whatever_is_resolved_formats_to_nothing_but_the_template(self) -> None:
        colour = r"(#[0-9A-F]{6}|rgba\(\d{1,3}, \d{1,3}, \d{1,3}, [01]?\.?\d*\)|transparent)"
        line = re.compile(
            r"/\* Organisationens accentfärg: #[0-9A-F]{6}, mörkt läge #[0-9A-F]{6}\. Skapad av modulens backend\. \*/"
            r'|\[data-astryx-theme="eneo"\] \{|\}'
            r"|  --color-accent: light-dark\(#[0-9A-F]{6}, #[0-9A-F]{6}\);"
            r"|  --color-on-accent: light-dark\(#[0-9A-F]{6}, #[0-9A-F]{6}\);"
            rf"|  --(color|shadow|module)-[a-z-]+: ((inset )?(-?\d+(px)? ){{3,4}})?light-dark\({colour}, {colour}\)"
            rf"(, ((inset )?(-?\d+(px)? ){{3,4}})light-dark\({colour}, {colour}\))*;"
        )
        for light in ("#004595", "#1C7531", "#B3261E", "#6B1EFD", "#00695C", "#5E6B00", "#0000FF", "#000000", "#1c7531"):
            css = theme_css(resolve_accent(light, None))
            for text in css.splitlines():
                self.assertRegex(text, line)

    def test_the_etag_follows_the_content(self) -> None:
        self.assertRegex(etag(theme_css(GREEN)), r'\A"[0-9a-f]{16}"\Z')
        self.assertEqual(etag(theme_css(GREEN)), etag(theme_css(GREEN)))
        self.assertNotEqual(etag(theme_css(GREEN)), etag(theme_css(None)))


if __name__ == "__main__":
    unittest.main()
