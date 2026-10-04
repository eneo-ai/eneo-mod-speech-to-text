import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from app.config import Settings


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = REPOSITORY_ROOT / "docker-compose.yml"


@unittest.skipUnless(shutil.which("docker"), "Docker is required for Compose checks")
class DeploymentComposeTests(unittest.TestCase):
    def test_frontend_targets_the_module_specific_backend_service(self) -> None:
        result = subprocess.run(
            [
                "docker",
                "compose",
                "-f",
                str(COMPOSE_FILE),
                "config",
                "--no-interpolate",
                "--format",
                "json",
            ],
            cwd=REPOSITORY_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        services = json.loads(result.stdout)["services"]

        self.assertIn("speech-to-text-backend", services)
        self.assertNotIn("backend", services)
        self.assertEqual(
            services["frontend"]["environment"]["INTERNAL_API_BASE"],
            "http://speech-to-text-backend:8000",
        )
        self.assertEqual(
            services["frontend"]["depends_on"]["speech-to-text-backend"][
                "condition"
            ],
            "service_healthy",
        )

    def interpolated_backend_environment(self, **variables: str) -> dict[str, str]:
        environment = {
            "PATH": os.environ["PATH"],
            "HOME": os.environ.get("HOME", "/"),
            "ENEO_BACKEND_URL": "https://eneo.example.test",
            "ENEO_PUBLIC_URL": "https://eneo.example.test",
            "MODULE_PUBLIC_URL": "https://module.example.test",
            "ENEO_API_KEY": "test-key",
            "SESSION_SECRET": "x" * 48,
            **variables,
        }
        result = subprocess.run(
            ["docker", "compose", "-f", str(COMPOSE_FILE), "config", "--format", "json"],
            cwd=REPOSITORY_ROOT,
            check=True,
            capture_output=True,
            text=True,
            env=environment,
        )
        return json.loads(result.stdout)["services"]["speech-to-text-backend"]["environment"]

    def test_the_body_limits_default_to_what_the_backend_defaults_to_and_can_be_set(self) -> None:
        defaults = Settings.model_fields
        unset = self.interpolated_backend_environment()
        empty = self.interpolated_backend_environment(MAX_BODY_BYTES="", MAX_UPLOAD_BYTES="", MAX_RESPONSE_BYTES="")
        chosen = self.interpolated_backend_environment(MAX_BODY_BYTES="2048", MAX_UPLOAD_BYTES="5000000", MAX_RESPONSE_BYTES="4096")

        for environment in (unset, empty):
            self.assertEqual(int(environment["MAX_BODY_BYTES"]), defaults["max_body_bytes"].default)
            self.assertEqual(int(environment["MAX_UPLOAD_BYTES"]), defaults["max_upload_bytes"].default)
            self.assertEqual(int(environment["MAX_RESPONSE_BYTES"]), defaults["max_response_bytes"].default)
        self.assertEqual((chosen["MAX_BODY_BYTES"], chosen["MAX_UPLOAD_BYTES"], chosen["MAX_RESPONSE_BYTES"]), ("2048", "5000000", "4096"))


class BrandingSettingsReachTheBackendTests(unittest.TestCase):
    def test_every_organization_setting_is_passed_to_the_backend_service(self) -> None:
        compose = COMPOSE_FILE.read_text()
        for name in (
            "ORGANIZATION_NAME",
            "ORGANIZATION_LOGO",
            "ORGANIZATION_LOGO_DARK",
            "SHOW_ORGANIZATION",
            "ORGANIZATION_ACCENT",
            "ORGANIZATION_ACCENT_DARK",
        ):
            with self.subTest(name=name):
                self.assertRegex(compose, rf"(?m)^      {name}: \$\{{{name}:-", msg=f"{name} is not passed through docker-compose.yml")


if __name__ == "__main__":
    unittest.main()
