import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.config import FlowListScope, Organization, load_settings

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
        self.assertEqual(settings.auth_mode, "eneo_sso")
        self.assertIsNone(settings.app_access_code)
        self.assertTrue(settings.cookie_secure)

    def test_loads_access_code_mode_without_eneo_public_url(self) -> None:
        environment = valid_environment()
        environment.pop("ENEO_PUBLIC_URL")
        environment["AUTH_MODE"] = "access_code"
        environment["APP_ACCESS_CODE"] = "test-access-code-1234"

        with patch.dict(os.environ, environment, clear=True):
            settings = load_settings()

        self.assertEqual(settings.auth_mode, "access_code")
        self.assertIsNone(settings.eneo_public_url)
        assert settings.app_access_code is not None
        self.assertEqual(
            settings.app_access_code.get_secret_value(),
            "test-access-code-1234",
        )

    def test_the_auth_mode_decides_whether_the_flow_list_names_a_space(self) -> None:
        environment = valid_environment()
        environment["DEMO_SPACE_ID"] = "space-demo"
        with patch.dict(os.environ, environment, clear=True):
            sso = load_settings()
        # An SSO user's list covers every space they belong to, even with a space configured.
        self.assertEqual(sso.flow_list_scope, FlowListScope(space_id=None))

        environment.pop("ENEO_PUBLIC_URL")
        environment["AUTH_MODE"] = "access_code"
        environment["APP_ACCESS_CODE"] = "test-access-code-1234"
        with patch.dict(os.environ, environment, clear=True):
            access_code = load_settings()
        # The module key alone must name its space, from the first request.
        self.assertEqual(access_code.flow_list_scope, FlowListScope(space_id="space-demo"))

    def test_access_code_without_a_space_says_so_at_configuration(self) -> None:
        environment = valid_environment()
        environment.pop("ENEO_PUBLIC_URL")
        environment["AUTH_MODE"] = "access_code"
        environment["APP_ACCESS_CODE"] = "test-access-code-1234"

        with patch.dict(os.environ, environment, clear=True), self.assertLogs("eneo_config", level="ERROR") as logs:
            settings = load_settings()

        self.assertIsNone(settings.flow_list_scope)
        self.assertEqual(len(logs.output), 1)
        self.assertIn("DEMO_SPACE_ID", logs.output[0])

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

    def test_rejects_unknown_auth_mode(self) -> None:
        environment = valid_environment()
        environment["AUTH_MODE"] = "automatic"

        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "AUTH_MODE"):
                load_settings()

    def test_access_code_mode_requires_access_code(self) -> None:
        environment = valid_environment()
        environment["AUTH_MODE"] = "access_code"

        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "APP_ACCESS_CODE"):
                load_settings()

    def test_rejects_short_access_code(self) -> None:
        environment = valid_environment()
        environment["AUTH_MODE"] = "access_code"
        environment["APP_ACCESS_CODE"] = "abc"

        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "between 16 and 256"):
                load_settings()

    def test_sso_mode_rejects_access_code(self) -> None:
        environment = valid_environment()
        environment["APP_ACCESS_CODE"] = "unused-access-code"

        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "only be set"):
                load_settings()

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
        self.assertEqual(settings.organization, Organization(name="Umeå kommun", logo="custom", dark_logo=True))
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
        self.assertEqual(settings.organization, Organization(name="Umeå kommun", logo="custom", dark_logo=False))

    def test_a_logo_needs_the_name_it_stands_for(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "ORGANIZATION_NAME"):
            self.load(ORGANIZATION_LOGO=self.file("logo.svg", SVG))

    def test_rejects_an_ambiguous_show_organization(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "SHOW_ORGANIZATION must be a boolean"):
            self.load(SHOW_ORGANIZATION="kanske")


if __name__ == "__main__":
    unittest.main()
