import json
import shutil
import subprocess
import unittest
from pathlib import Path


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
