import os
import unittest
from unittest.mock import patch

from app.config import FlowListScope, load_settings


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


if __name__ == "__main__":
    unittest.main()
