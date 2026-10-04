import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app.accent import Accent
from app.config import LogoSize, LogoSizes, Organization, Settings, load_settings

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c6360000200000500017a5eab3f0000000049454e44ae426082")  # a real 1x1 PNG
SVG = b'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 4"></svg>'


def valid_environment() -> dict[str, str]:
    return {
        "ENEO_BACKEND_URL": "http://backend:8000",
        "ENEO_PUBLIC_URL": "https://eneo.example.test",
        "MODULE_PUBLIC_URL": "https://module.example.test",
        "MODULE_KEY": "speech-to-text",
        "ENEO_API_KEY": "test-key",
        "SESSION_SECRET": "x" * 48,
        "COOKIE_SECURE": "true",
    }


class SettingsTests(unittest.TestCase):
    def test_loads_module_contract(self) -> None:
        with patch.dict(os.environ, valid_environment(), clear=True):
            settings = load_settings()

        self.assertEqual(settings.eneo_backend_url, "http://backend:8000")
        self.assertEqual(settings.module_key, "speech-to-text")
        self.assertEqual(settings.eneo_api_key_header_name, "X-API-Key")
        self.assertTrue(settings.cookie_secure)

    def test_session_max_age_defaults_to_eight_hours(self) -> None:
        with patch.dict(os.environ, valid_environment(), clear=True):
            settings = load_settings()

        self.assertEqual(settings.session_max_age_seconds, 8 * 60 * 60)

    def test_session_max_age_is_configurable_in_minutes(self) -> None:
        environment = valid_environment()
        environment["SESSION_MAX_AGE_MINUTES"] = "90"

        with patch.dict(os.environ, environment, clear=True):
            settings = load_settings()

        self.assertEqual(settings.session_max_age_seconds, 90 * 60)

    def test_rejects_invalid_session_max_age(self) -> None:
        for raw in ("0", "-5", "eight"):
            environment = valid_environment()
            environment["SESSION_MAX_AGE_MINUTES"] = raw
            with self.subTest(raw=raw):
                with patch.dict(os.environ, environment, clear=True):
                    with self.assertRaisesRegex(RuntimeError, "SESSION_MAX_AGE_MINUTES"):
                        load_settings()

    def test_body_limits_default_to_10_mib_and_1_gib(self) -> None:
        with patch.dict(os.environ, valid_environment(), clear=True):
            settings = load_settings()

        self.assertEqual((settings.max_body_bytes, settings.max_upload_bytes), (10 * 1024 * 1024, 1024**3))
        self.assertEqual(settings.max_response_bytes, 32 * 1024 * 1024)

    def test_body_limits_are_configurable(self) -> None:
        environment = valid_environment() | {"MAX_BODY_BYTES": "2048", "MAX_UPLOAD_BYTES": "5000000", "MAX_RESPONSE_BYTES": "4096"}

        with patch.dict(os.environ, environment, clear=True):
            settings = load_settings()

        self.assertEqual((settings.max_body_bytes, settings.max_upload_bytes, settings.max_response_bytes), (2048, 5_000_000, 4096))

    def test_rejects_invalid_body_limits(self) -> None:
        # An empty value is refused too: docker-compose.yml gives the defaults itself, so it never passes one.
        for name in ("MAX_BODY_BYTES", "MAX_UPLOAD_BYTES", "MAX_RESPONSE_BYTES"):
            for raw in ("0", "-5", "ten", "", "1.5", "inf", "nan", "9" * 5000, "9" * 30):
                with self.subTest(name=name, raw=raw):
                    with patch.dict(os.environ, valid_environment() | {name: raw}, clear=True):
                        with self.assertRaisesRegex(RuntimeError, name):
                            load_settings()

    def test_the_upload_budget_is_a_finite_number_greater_than_zero(self) -> None:
        # An infinite budget would defeat the total deadline on the forward of an upload.
        for raw in ("inf", "-inf", "Infinity", "nan", "1e999", "1e308", "0", "-1", "abc", "", "86401"):
            with self.subTest(raw=raw):
                with patch.dict(os.environ, valid_environment() | {"UPLOAD_PROXY_TIMEOUT_SECONDS": raw}, clear=True):
                    with self.assertRaisesRegex(RuntimeError, "UPLOAD_PROXY_TIMEOUT_SECONDS"):
                        load_settings()

    def test_the_upload_budget_takes_a_number_of_seconds(self) -> None:
        for raw, seconds in (("1800", 1800.0), ("0.5", 0.5), ("86400", 86400.0)):
            with self.subTest(raw=raw):
                with patch.dict(os.environ, valid_environment() | {"UPLOAD_PROXY_TIMEOUT_SECONDS": raw}, clear=True):
                    self.assertEqual(load_settings().upload_proxy_timeout_seconds, seconds)

    def test_the_default_upload_budget_is_30_minutes(self) -> None:
        with patch.dict(os.environ, valid_environment(), clear=True):
            self.assertEqual(load_settings().upload_proxy_timeout_seconds, 1800.0)

    def test_static_dir_is_the_folder_of_the_built_ui_or_nothing(self) -> None:
        for raw, expected in ((None, None), ("", None), ("/app/frontend/dist", Path("/app/frontend/dist"))):
            with self.subTest(raw=raw):
                environment = valid_environment() | ({} if raw is None else {"STATIC_DIR": raw})
                with patch.dict(os.environ, environment, clear=True):
                    self.assertEqual(load_settings().static_dir, expected)

    def test_loads_custom_api_key_header_name(self) -> None:
        environment = valid_environment()
        environment["ENEO_API_KEY_HEADER_NAME"] = "X-Eneo-Module-Key"

        with patch.dict(os.environ, environment, clear=True):
            settings = load_settings()

        self.assertEqual(settings.eneo_api_key_header_name, "X-Eneo-Module-Key")

    def test_rejects_invalid_api_key_header_name(self) -> None:
        environment = valid_environment()
        environment["ENEO_API_KEY_HEADER_NAME"] = "X-API-Key: injected"

        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "valid HTTP header"):
                load_settings()

    def test_rejects_unstable_module_key(self) -> None:
        environment = valid_environment()
        environment["MODULE_KEY"] = "Speech To Text"

        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "lowercase kebab-case"):
                load_settings()

    def test_rejects_public_url_with_query_string(self) -> None:
        environment = valid_environment()
        environment["MODULE_PUBLIC_URL"] = "https://module.example.test?ticket=bad"

        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "query string or fragment"):
                load_settings()

    def test_there_is_one_way_to_sign_in_and_nothing_to_choose(self) -> None:
        # The access code is gone: no mode, no code, no space the module key alone would have to name.
        for name in ("auth_mode", "app_access_code", "demo_space_id", "flow_list_scope"):
            self.assertNotIn(name, Settings.model_fields)
            self.assertFalse(hasattr(Settings, name), name)

    def test_eneo_public_url_is_required(self) -> None:
        environment = valid_environment()
        environment.pop("ENEO_PUBLIC_URL")

        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "ENEO_PUBLIC_URL"):
                load_settings()

    LOOPBACK = ("http://localhost", "http://localhost:3002", "http://127.0.0.1:3002", "http://[::1]:3002", "http://LOCALHOST:3002")
    NOT_LOOPBACK = (
        "http://module.example.test",
        "http://localhost.evil.test",
        "http://127.0.0.1.evil.test",
        "http://localhost@evil.test",
        "http://127.0.0.1:80@evil.test",
        "http://localhost.:3002",
        "http://0.0.0.0:3002",
        "http://127.1",
        "http://[::ffff:127.0.0.1]:3002",
        "http://[::2]",
        "http://192.168.1.10:3002",
    )

    def test_an_http_public_url_is_accepted_only_for_a_loopback_host(self) -> None:
        for name in ("MODULE_PUBLIC_URL", "ENEO_PUBLIC_URL"):
            for url in self.LOOPBACK:
                with self.subTest(name=name, url=url):
                    with patch.dict(os.environ, valid_environment() | {name: url}, clear=True):
                        self.assertEqual(getattr(load_settings(), name.lower()), url.rstrip("/"))
            for url in self.NOT_LOOPBACK:
                with self.subTest(name=name, url=url):
                    with patch.dict(os.environ, valid_environment() | {name: url}, clear=True):
                        with self.assertRaisesRegex(RuntimeError, rf"{name} must be an https URL.*localhost, 127\.0\.0\.1 or \[::1\]"):
                            load_settings()

    def test_an_https_public_url_is_accepted_for_any_host(self) -> None:
        for url in ("https://module.example.test", "https://localhost:3002", "https://192.168.1.10"):
            with self.subTest(url=url), patch.dict(os.environ, valid_environment() | {"MODULE_PUBLIC_URL": url}, clear=True):
                self.assertEqual(load_settings().module_public_url, url)

    def test_the_backend_url_may_be_http_on_the_service_network(self) -> None:
        for url in ("http://backend:8000", "http://eneo-backend.internal:8000", "http://host.docker.internal:8123"):
            with self.subTest(url=url), patch.dict(os.environ, valid_environment() | {"ENEO_BACKEND_URL": url}, clear=True):
                self.assertEqual(load_settings().eneo_backend_url, url)

    def test_the_cookie_may_leave_secure_only_for_a_loopback_module(self) -> None:
        for url in self.LOOPBACK:
            with self.subTest(url=url), patch.dict(os.environ, valid_environment() | {"MODULE_PUBLIC_URL": url, "COOKIE_SECURE": "false"}, clear=True):
                self.assertFalse(load_settings().cookie_secure)
        for url in ("https://module.example.test", *self.NOT_LOOPBACK):
            with self.subTest(url=url):
                environment = valid_environment() | {"MODULE_PUBLIC_URL": url, "COOKIE_SECURE": "false"}
                with patch.dict(os.environ, environment, clear=True):
                    with self.assertRaises(RuntimeError) as refused:
                        load_settings()
                if url.startswith("https://"):  # the URL is fine, the cookie setting is what is refused
                    self.assertRegex(str(refused.exception), r"COOKIE_SECURE=false.*MODULE_PUBLIC_URL.*localhost, 127\.0\.0\.1 or \[::1\]")

    def test_a_loopback_module_may_keep_the_cookie_secure(self) -> None:
        with patch.dict(os.environ, valid_environment() | {"MODULE_PUBLIC_URL": "http://localhost:3002"}, clear=True):
            self.assertTrue(load_settings().cookie_secure)

    def test_rejects_ambiguous_cookie_secure_value(self) -> None:
        environment = valid_environment()
        environment["COOKIE_SECURE"] = "truthy"

        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "must be a boolean"):
                load_settings()


class OrganizationTests(unittest.TestCase):
    """The organisation beside "Tal till text", set per deployment."""

    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)

    def file(self, name: str, content: bytes) -> str:
        path = self.folder / name
        path.write_bytes(content)
        return str(path)

    def load(self, **overrides: str):
        environment = valid_environment() | overrides
        with patch.dict(os.environ, environment, clear=True):
            return load_settings()

    def test_the_default_is_sundsvall_with_its_bundled_logo(self) -> None:
        settings = self.load()
        self.assertEqual(settings.organization, Organization(name="Sundsvalls kommun", logo="default"))
        self.assertIsNone(settings.organization_logo)

    def test_another_organisation_mounts_its_own_logo_and_names_itself(self) -> None:
        settings = self.load(
            ORGANIZATION_NAME="Umeå kommun",
            ORGANIZATION_LOGO=self.file("umea.svg", SVG),
            ORGANIZATION_LOGO_DARK=self.file("umea-dark.png", PNG),
        )
        self.assertEqual(
            settings.organization,
            Organization(
                name="Umeå kommun",
                logo="custom",
                dark_logo=True,
                logo_sizes=LogoSizes(light=LogoSize(width=10, height=4), dark=LogoSize(width=1, height=1)),
            ),
        )
        assert settings.organization_logo and settings.organization_logo_dark
        self.assertEqual(settings.organization_logo.media_type, "image/svg+xml")
        self.assertEqual(settings.organization_logo.content, SVG)
        self.assertEqual(settings.organization_logo_dark.media_type, "image/png")

    def test_a_name_without_a_logo_shows_the_name_never_sundsvalls_logo(self) -> None:
        settings = self.load(ORGANIZATION_NAME="Region Västernorrland")
        self.assertEqual(settings.organization, Organization(name="Region Västernorrland", logo=None))

    def test_the_organisation_can_be_hidden_leaving_the_product_name(self) -> None:
        settings = self.load(SHOW_ORGANIZATION="false", ORGANIZATION_LOGO=self.file("logo.svg", SVG))
        self.assertIsNone(settings.organization)
        self.assertIsNone(settings.organization_logo)

    def test_a_missing_logo_says_so_once_and_the_name_stands_in(self) -> None:
        with self.assertLogs("eneo_config", level="ERROR") as logs:
            settings = self.load(ORGANIZATION_NAME="Umeå kommun", ORGANIZATION_LOGO=str(self.folder / "saknas.svg"))
        self.assertEqual(settings.organization, Organization(name="Umeå kommun", logo=None))
        self.assertEqual(len(logs.output), 1)
        self.assertIn("ORGANIZATION_LOGO", logs.output[0])

    def test_only_svg_and_png_are_logos(self) -> None:
        for name, content in (
            ("logo.gif", b"GIF89a" + b"\x00" * 16),
            ("logo.svg", PNG),  # the name says SVG, the content does not
            ("logo.png", b"<html><script>alert(1)</script></html>"),
        ):
            with self.subTest(name=name), self.assertLogs("eneo_config", level="ERROR"):
                settings = self.load(ORGANIZATION_NAME="Umeå kommun", ORGANIZATION_LOGO=self.file(name, content))
            self.assertEqual(settings.organization, Organization(name="Umeå kommun", logo=None))

    def test_a_large_file_is_refused_without_reading_it_whole(self) -> None:
        big = self.file("logo.svg", b'<svg xmlns="http://www.w3.org/2000/svg">' + b" " * (3 * 2**20) + b"</svg>")
        reads: list[int] = []
        real_open = Path.open

        def spying_open(path: Path, *args, **kwargs):
            handle = real_open(path, *args, **kwargs)
            if str(path) != big:
                return handle
            real_read = handle.read

            def read(size: int = -1) -> bytes:
                reads.append(size)
                return real_read(size)

            handle.read = read  # type: ignore[method-assign]
            return handle

        with patch.object(Path, "open", spying_open), self.assertLogs("eneo_config", level="ERROR") as logs:
            settings = self.load(ORGANIZATION_NAME="Umeå kommun", ORGANIZATION_LOGO=big)
        self.assertEqual(settings.organization, Organization(name="Umeå kommun", logo=None))
        self.assertIn("larger than 1 MiB", logs.output[0])
        self.assertEqual(reads, [2**20 + 1], "the read stops one byte past the limit")

    def test_a_missing_dark_logo_keeps_the_light_one(self) -> None:
        with self.assertLogs("eneo_config", level="ERROR"):
            settings = self.load(
                ORGANIZATION_NAME="Umeå kommun",
                ORGANIZATION_LOGO=self.file("umea.svg", SVG),
                ORGANIZATION_LOGO_DARK=str(self.folder / "saknas.svg"),
            )
        self.assertEqual(
            settings.organization,
            Organization(name="Umeå kommun", logo="custom", logo_sizes=LogoSizes(light=LogoSize(width=10, height=4))),
        )

    def sizes_of(self, name: str, content: bytes):
        return self.load(ORGANIZATION_NAME="Umeå kommun", ORGANIZATION_LOGO=self.file(name, content)).organization

    def test_a_logo_carries_its_proportions_so_the_page_can_reserve_its_room(self) -> None:
        svg = lambda attributes: b'<svg xmlns="http://www.w3.org/2000/svg" ' + attributes + b"></svg>"  # noqa: E731
        for what, content, expected in (
            ("a viewBox", svg(b'viewBox="0 0 160 40"'), (160, 40)),
            ("a viewBox that does not start at zero", svg(b'viewBox="-5 -5, 160,40"'), (160, 40)),
            ("a width and a height, unitless", svg(b'width="300" height="75"'), (300, 75)),
            ("a width and a height in px, which win over the viewBox", svg(b'width="300px" height="60px" viewBox="0 0 10 10"'), (300, 60)),
            ("single quotes", svg(b"width='300' height='75'"), (300, 75)),
            ("a width and the viewBox's proportions", svg(b'width="200" viewBox="0 0 10 5"'), (200, 100)),
            ("a height and the viewBox's proportions", svg(b'height="50" viewBox="0 0 10 5"'), (100, 50)),
            ("a percentage, which says nothing, and a viewBox", svg(b'width="100%" height="100%" viewBox="0 0 90 30"'), (90, 30)),
            ("fractions, scaled so the proportions survive a whole number", svg(b'viewBox="0 0 10.5 4.5"'), (1000, 429)),
            ("Illustrator's decimals", svg(b'width="277.4px" height="110.3px"'), (1000, 398)),
            ("a root tag that holds a > in a value", svg(b'data-x="a>b" viewBox="0 0 8 2"'), (8, 2)),
        ):
            with self.subTest(what):
                organization = self.sizes_of("logo.svg", content)
                assert organization is not None and organization.logo_sizes is not None
                self.assertEqual((organization.logo_sizes.light.width, organization.logo_sizes.light.height), expected)
                self.assertIsNone(organization.logo_sizes.dark)

    def test_a_comment_before_the_svg_tag_is_not_its_size(self) -> None:
        organization = self.sizes_of("logo.svg", b'<!-- <svg width="1" height="1"> -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 3"></svg>')
        assert organization is not None and organization.logo_sizes is not None
        self.assertEqual(organization.logo_sizes.light, LogoSize(width=12, height=3))

    def test_a_png_is_as_large_as_its_header_says(self) -> None:
        png = bytearray(PNG)
        png[16:24] = (640).to_bytes(4, "big") + (96).to_bytes(4, "big")
        organization = self.sizes_of("logo.png", bytes(png))
        assert organization is not None and organization.logo_sizes is not None
        self.assertEqual(organization.logo_sizes.light, LogoSize(width=640, height=96))

    def test_a_logo_without_a_readable_size_says_so_once_and_the_name_stands_in(self) -> None:
        svg = lambda attributes: b'<svg xmlns="http://www.w3.org/2000/svg" ' + attributes + b"></svg>"  # noqa: E731
        truncated_png = PNG[:20]
        zero_png = bytearray(PNG)
        zero_png[16:20] = (0).to_bytes(4, "big")
        for name, content in (
            ("logo.svg", svg(b"")),
            ("logo.svg", svg(b'width="100%" height="50%"')),
            ("logo.svg", svg(b'viewBox="0 0 0 40"')),
            ("logo.svg", svg(b'viewBox="0 0 160"')),
            ("logo.svg", svg(b'viewBox="0 0 -160 40"')),
            ("logo.svg", svg(b'viewBox="0 0 1e999 40"')),
            ("logo.png", truncated_png),
            ("logo.png", bytes(zero_png)),
        ):
            with self.subTest(name=name, content=content[:60]), self.assertLogs("eneo_config", level="ERROR") as logs:
                organization = self.sizes_of(name, content)
            self.assertEqual(organization, Organization(name="Umeå kommun", logo=None))
            self.assertEqual(len(logs.output), 1)
            self.assertIn("ORGANIZATION_LOGO", logs.output[0])
            self.assertIn("size", logs.output[0])

    def test_an_organisation_names_its_logos_sizes_exactly_when_it_has_logos(self) -> None:
        size = LogoSize(width=2, height=1)
        for attributes in (
            {"logo": "custom"},  # no sizes
            {"logo": "custom", "logo_sizes": LogoSizes(light=size), "dark_logo": True},  # a dark logo with no size
            {"logo": "custom", "logo_sizes": LogoSizes(light=size, dark=size), "dark_logo": False},  # a size for no logo
            {"logo": "default", "logo_sizes": LogoSizes(light=size)},
            {"logo": None, "logo_sizes": LogoSizes(light=size)},
        ):
            with self.subTest(attributes), self.assertRaises(ValueError):
                Organization(name="Umeå kommun", **attributes)

    def test_a_logo_needs_the_name_it_stands_for(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "ORGANIZATION_NAME"):
            self.load(ORGANIZATION_LOGO=self.file("logo.svg", SVG))

    def test_rejects_an_ambiguous_show_organization(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "SHOW_ORGANIZATION must be a boolean"):
            self.load(SHOW_ORGANIZATION="kanske")

    def test_the_accent_is_set_apart_from_the_organisation_and_applies_hidden_or_shown(self) -> None:
        green = Accent(light="#1E7B34", dark="#2AAE4A", on_light="#FFFFFF", on_dark="#0B1118")
        self.assertIsNone(self.load().accent)
        # Whitespace around an environment value (a compose file's, a pasted line) is not part of the colour.
        self.assertEqual(self.load(ORGANIZATION_ACCENT=" #1e7b34\n").accent, green)
        self.assertEqual(self.load(SHOW_ORGANIZATION="false", ORGANIZATION_ACCENT="#1E7B34").accent, green)
        self.assertEqual(self.load(ORGANIZATION_ACCENT="#1E7B34", ORGANIZATION_ACCENT_DARK="#52B1FF").accent, replace(green, dark="#52B1FF"))

    def test_an_accent_that_cannot_be_used_refuses_to_start_with_one_swedish_error(self) -> None:
        for overrides, message in (
            ({"ORGANIZATION_ACCENT": "#FFD700"}, "ORGANIZATION_ACCENT=#FFD700: accentfärgen mot sidans ytor når 1,23:1 i ljust läge"),
            ({"ORGANIZATION_ACCENT": "grön"}, "ORGANIZATION_ACCENT måste vara en färg på formen #RRGGBB"),
            ({"ORGANIZATION_ACCENT": "#1E7B34;}body{display:none"}, "ORGANIZATION_ACCENT måste vara en färg på formen #RRGGBB"),
            ({"ORGANIZATION_ACCENT_DARK": "#52B1FF"}, "ORGANIZATION_ACCENT_DARK kräver ORGANIZATION_ACCENT"),
            ({"ORGANIZATION_ACCENT": "#1E7B34", "ORGANIZATION_ACCENT_DARK": "#1E7B34"}, "ORGANIZATION_ACCENT_DARK=#1E7B34: accentfärgen mot sidans ytor når"),
        ):
            with self.subTest(overrides=overrides), self.assertRaises(RuntimeError) as raised:
                self.load(**overrides)
            self.assertIn(message, str(raised.exception))


if __name__ == "__main__":
    unittest.main()
