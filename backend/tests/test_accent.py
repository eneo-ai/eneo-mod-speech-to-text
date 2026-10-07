import colorsys
import re
import unittest
from pathlib import Path

from app.accent import (
    DARK,
    LIGHT,
    NO_ACCENT_CSS,
    Accent,
    _hex,
    _problem,
    _swedish,
    contrast,
    etag,
    luminance,
    parse_hex,
    resolve_accent,
    theme_css,
)

GREEN = Accent(light="#1E7B34", dark="#2AAE4A", on_light="#FFFFFF", on_dark="#0B1118")
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

        def pair(token: str) -> tuple[str, str]:
            found = re.search(rf"--{token}: light-dark\((#[0-9A-F]{{6}}), (#[0-9A-F]{{6}})\)", css)
            assert found, token
            return found.group(1), found.group(2)

        surface, body, popover, secondary = (
            pair("color-background-surface"),
            pair("color-background-body"),
            pair("color-background-popover"),
            pair("color-text-secondary"),
        )
        self.assertEqual((LIGHT.surfaces, LIGHT.popover, LIGHT.secondary_text), ((surface[0], body[0]), popover[0], secondary[0]))
        self.assertEqual((DARK.surfaces, DARK.popover, DARK.secondary_text), ((surface[1], body[1]), popover[1], secondary[1]))
        self.assertIn("--color-accent-muted: light-dark(color-mix(in srgb, var(--color-accent) 20%, transparent), color-mix(in srgb, var(--color-accent) 25%, transparent))", css)


class ResolveTests(unittest.TestCase):
    def test_nothing_set_is_no_accent(self) -> None:
        self.assertIsNone(resolve_accent(None, None))
        self.assertIsNone(resolve_accent("", ""))

    def test_a_dark_accent_that_is_left_out_is_derived_from_the_light_one(self) -> None:
        self.assertEqual(resolve_accent("#1E7B34", None), GREEN)

    def test_a_given_dark_accent_is_used_as_it_is(self) -> None:
        accent = resolve_accent("#004595", "#52b1ff")
        assert accent is not None
        self.assertEqual((accent.light, accent.dark), ("#004595", "#52B1FF"))

    def test_the_derived_dark_accent_keeps_the_hue_and_meets_the_dark_mode(self) -> None:
        for light in ("#1E7B34", "#B3261E", "#6B1EFD", "#00695C", "#5E6B00", "#0000FF", "#000000"):
            accent = resolve_accent(light, None)
            assert accent is not None, light
            self.assertIsNone(_problem(_hex(accent.dark), DARK), light)
            hue = lambda value: colorsys.rgb_to_hls(*(c / 255 for c in _hex(value)))[0]  # noqa: E731
            if light != "#000000":  # no hue to keep
                self.assertLess(abs(hue(accent.dark) - hue(light)), 0.01, light)
            self.assertGreater(luminance(_hex(accent.dark)), luminance(_hex(light)), light)

    def test_the_text_on_the_accent_is_the_better_of_white_and_the_themes_near_black(self) -> None:
        accent = resolve_accent("#1E7B34", None)
        assert accent is not None
        self.assertEqual((accent.on_light, accent.on_dark), ("#FFFFFF", "#0B1118"))

    def test_a_colour_that_is_not_rrggbb_is_refused_for_its_form(self) -> None:
        with self.assertRaisesRegex(RuntimeError, r"ORGANIZATION_ACCENT måste vara en färg på formen #RRGGBB.*'blue'"):
            resolve_accent("blue", None)
        with self.assertRaisesRegex(RuntimeError, r"ORGANIZATION_ACCENT_DARK måste vara en färg på formen #RRGGBB"):
            resolve_accent("#1E7B34", "#fff")

    def test_each_refusal_names_the_measured_ratio_and_the_minimum(self) -> None:
        cases = [
            (("#FFD700", None), "ORGANIZATION_ACCENT=#FFD700: accentfärgen mot sidans ytor når 1,23:1 i ljust läge men måste nå minst 4,50:1. Välj en mörkare färg."),
            (("#767676", None), "ORGANIZATION_ACCENT=#767676: accentfärgen mot sidans ytor når 4,00:1 i ljust läge men måste nå minst 4,50:1. Välj en mörkare färg."),
            (("#004595", "#004595"), "ORGANIZATION_ACCENT_DARK=#004595: accentfärgen mot sidans ytor når 1,42:1 i mörkt läge men måste nå minst 4,50:1. Välj en ljusare färg."),
        ]
        for arguments, message in cases:
            with self.assertRaises(RuntimeError) as raised:
                resolve_accent(*arguments)
            self.assertEqual(str(raised.exception), message)

    def test_a_dark_accent_too_bright_for_selected_rows_says_so(self) -> None:
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


class ThemeCssTests(unittest.TestCase):
    def test_no_accent_is_a_harmless_comment(self) -> None:
        self.assertEqual(theme_css(None), NO_ACCENT_CSS)
        self.assertRegex(NO_ACCENT_CSS, r"\A/\*[^{}]*\*/\n\Z")

    def test_the_stylesheet_is_exactly_this(self) -> None:
        self.assertEqual(
            theme_css(GREEN),
            "/* Organisationens accentfärg: #1E7B34, mörkt läge #2AAE4A. Skapad av modulens backend. */\n"
            '[data-astryx-theme="eneo"] {\n'
            "  --color-accent: light-dark(#1E7B34, #2AAE4A);\n"
            "  --color-on-accent: light-dark(#FFFFFF, #0B1118);\n"
            "}\n",
        )

    def test_whatever_is_resolved_formats_to_nothing_but_the_template(self) -> None:
        line = re.compile(
            r"/\* Organisationens accentfärg: #[0-9A-F]{6}, mörkt läge #[0-9A-F]{6}\. Skapad av modulens backend\. \*/"
            r'|\[data-astryx-theme="eneo"\] \{|\}'
            r"|  --color-accent: light-dark\(#[0-9A-F]{6}, #[0-9A-F]{6}\);"
            r"|  --color-on-accent: light-dark\(#[0-9A-F]{6}, #[0-9A-F]{6}\);"
        )
        for light in ("#004595", "#1E7B34", "#B3261E", "#6B1EFD", "#00695C", "#5E6B00", "#0000FF", "#000000", "#1e7b34"):
            css = theme_css(resolve_accent(light, None))
            for text in css.splitlines():
                self.assertRegex(text, line)

    def test_the_etag_follows_the_content(self) -> None:
        self.assertRegex(etag(theme_css(GREEN)), r'\A"[0-9a-f]{16}"\Z')
        self.assertEqual(etag(theme_css(GREEN)), etag(theme_css(GREEN)))
        self.assertNotEqual(etag(theme_css(GREEN)), etag(theme_css(None)))


if __name__ == "__main__":
    unittest.main()
