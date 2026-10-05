import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from app.config import Settings


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = REPOSITORY_ROOT / "docker-compose.yml"
OVERRIDE_FILE = REPOSITORY_ROOT / "docker-compose.override.yml"
SERVICE = "speech-to-text"
IMAGE = "ghcr.io/eneo-ai/eneo-mod-speech-to-text"


def compose_config(*, interpolate: bool = True, files: tuple[Path, ...] = (COMPOSE_FILE,), **variables: str) -> dict:
    """``docker compose config`` of ``files`` (docker-compose.yml, the file an operator pastes into Dokploy or Portainer, unless
    named) as JSON; ``variables`` are what the operator's environment sets."""
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
        ["docker", "compose", *(arg for file in files for arg in ("-f", str(file))), "config", *([] if interpolate else ["--no-interpolate"]), "--format", "json"],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )
    return json.loads(result.stdout)


@unittest.skipUnless(shutil.which("docker"), "Docker is required for Compose checks")
class DeploymentComposeTests(unittest.TestCase):
    def test_one_service_pulls_the_published_image_and_the_version_is_the_operators_to_choose(self) -> None:
        service = compose_config(interpolate=False)["services"][SERVICE]

        # The service name is the module's own: a generic one collides with Eneo's on Dokploy's shared network.
        self.assertEqual(list(compose_config(interpolate=False)["services"]), [SERVICE])
        self.assertEqual(service["image"], f"{IMAGE}:${{MODULE_VERSION:-latest}}")
        # Paste the file into Dokploy or Portainer and it runs: nothing in it is built.
        self.assertNotIn("build", service)
        for variables, expected in (({}, "latest"), ({"MODULE_VERSION": ""}, "latest"), ({"MODULE_VERSION": "v1.2.3"}, "v1.2.3")):
            with self.subTest(variables=variables):
                self.assertEqual(compose_config(**variables)["services"][SERVICE]["image"], f"{IMAGE}:{expected}")

    def test_the_override_builds_the_image_from_the_repository_root_for_development(self) -> None:
        # docker compose up merges the override; Dokploy and Portainer take docker-compose.yml alone.
        service = compose_config(interpolate=False, files=(COMPOSE_FILE, OVERRIDE_FILE))["services"][SERVICE]

        build = service["build"]
        self.assertEqual(Path(build["context"]).resolve(), REPOSITORY_ROOT)
        self.assertEqual(build.get("dockerfile", "Dockerfile"), "Dockerfile")
        self.assertEqual(build["args"]["SPEAKER_REVIEW_ENABLED"], "${SPEAKER_REVIEW_ENABLED:-false}")
        # A local build has a name of its own, so a pulled release is never mistaken for it.
        self.assertEqual(service["image"], "eneo-mod-speech-to-text:local")
        # The speaker review is a build argument, off unless the operator builds with it on.
        for variables, expected in (({}, "false"), ({"SPEAKER_REVIEW_ENABLED": "true"}, "true")):
            with self.subTest(variables=variables):
                merged = compose_config(files=(COMPOSE_FILE, OVERRIDE_FILE), **variables)["services"][SERVICE]
                self.assertEqual(merged["build"]["args"]["SPEAKER_REVIEW_ENABLED"], expected)

    def test_the_service_is_on_3001_checks_its_health_there_and_restarts_itself(self) -> None:
        service = compose_config()["services"][SERVICE]

        self.assertEqual(service["expose"], ["3001"])
        self.assertNotIn("ports", service)  # published only by docker-compose.override.yml, for development; Dokploy routes to the port
        self.assertIn("http://127.0.0.1:3001/health", " ".join(service["healthcheck"]["test"]))
        # One process, no supervisor: restarting it when it dies is the container's job.
        self.assertEqual(service["restart"], "unless-stopped")

    def test_the_container_has_no_more_than_it_needs(self) -> None:
        service = compose_config()["services"][SERVICE]

        self.assertIs(service["read_only"], True)
        self.assertEqual(service["cap_drop"], ["ALL"])
        self.assertNotIn("cap_add", service)
        self.assertIn("no-new-privileges:true", service["security_opt"])
        # The one writable place is where an upload is spooled (Starlette's SpooledTemporaryFile, past 1 MB). A volume,
        # which is the disk: a tmpfs would hold every upload in memory.
        temp = [mount for mount in service["volumes"] if mount["target"] == "/tmp"]
        self.assertEqual([(mount["type"], mount.get("read_only", False)) for mount in temp], [("volume", False)])
        self.assertNotIn("tmpfs", service)

    def test_the_override_publishes_3001_for_development_only(self) -> None:
        override = OVERRIDE_FILE.read_text()

        self.assertRegex(override, r'(?m)^    ports:\n      - "3001:3001"$')
        self.assertNotIn("frontend", override)

    def test_the_body_limits_default_to_what_the_backend_defaults_to_and_can_be_set(self) -> None:
        defaults = Settings.model_fields
        environment = lambda config: config["services"][SERVICE]["environment"]
        unset = environment(compose_config())
        empty = environment(compose_config(MAX_BODY_BYTES="", MAX_UPLOAD_BYTES="", MAX_RESPONSE_BYTES=""))
        chosen = environment(compose_config(MAX_BODY_BYTES="2048", MAX_UPLOAD_BYTES="5000000", MAX_RESPONSE_BYTES="4096"))

        for variables in (unset, empty):
            self.assertEqual(int(variables["MAX_BODY_BYTES"]), defaults["max_body_bytes"].default)
            self.assertEqual(int(variables["MAX_UPLOAD_BYTES"]), defaults["max_upload_bytes"].default)
            self.assertEqual(int(variables["MAX_RESPONSE_BYTES"]), defaults["max_response_bytes"].default)
        self.assertEqual((chosen["MAX_BODY_BYTES"], chosen["MAX_UPLOAD_BYTES"], chosen["MAX_RESPONSE_BYTES"]), ("2048", "5000000", "4096"))

    def test_the_upload_timeout_the_cookie_flag_the_key_header_and_the_session_age_default_to_the_backends(self) -> None:
        fields = Settings.model_fields
        environment = lambda config: config["services"][SERVICE]["environment"]
        names = ("UPLOAD_PROXY_TIMEOUT_SECONDS", "COOKIE_SECURE", "ENEO_API_KEY_HEADER_NAME", "SESSION_MAX_AGE_MINUTES")

        for variables in (environment(compose_config()), environment(compose_config(**dict.fromkeys(names, "")))):
            self.assertEqual(float(variables["UPLOAD_PROXY_TIMEOUT_SECONDS"]), fields["upload_proxy_timeout_seconds"].default)
            self.assertEqual(variables["COOKIE_SECURE"], str(fields["cookie_secure"].default).lower())
            self.assertEqual(variables["ENEO_API_KEY_HEADER_NAME"], fields["eneo_api_key_header_name"].default)
            self.assertEqual(int(variables["SESSION_MAX_AGE_MINUTES"]) * 60, fields["session_max_age_seconds"].default)
        chosen = environment(compose_config(SESSION_MAX_AGE_MINUTES="90"))
        self.assertEqual(chosen["SESSION_MAX_AGE_MINUTES"], "90")


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
