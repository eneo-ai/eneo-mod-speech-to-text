import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

import yaml
from app.config import Settings


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = REPOSITORY_ROOT / "docker-compose.yml"
OVERRIDE_FILE = REPOSITORY_ROOT / "docker-compose.override.yml"
TRAEFIK_FILE = REPOSITORY_ROOT / "docker-compose.traefik.yml"
ACCEPTANCE = REPOSITORY_ROOT / "deploy" / "acceptance"
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
        "MODULE_HOST": "module.example.test",
        "ACME_EMAIL": "ops@example.test",
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


@unittest.skipUnless(shutil.which("docker"), "Docker is required for Compose checks")
class TraefikOverlayTests(unittest.TestCase):
    """docker-compose.traefik.yml: the proxy for a host that has none. The base file stays neutral, and the acceptance's Traefik is held to the same
    timeouts, so what the acceptance tests is what an operator is given."""

    @staticmethod
    def overlay(**variables: str) -> dict:
        return compose_config(files=(COMPOSE_FILE, TRAEFIK_FILE), **variables)

    @staticmethod
    def flags(config: dict, prefix: str) -> dict[str, str]:
        found = (flag[2:].split("=", 1) for flag in config["services"]["traefik"]["command"] if flag.startswith(f"--{prefix}"))
        return {name: value for name, value in found}

    def test_the_base_file_is_proxy_neutral_and_the_overlay_adds_only_traefik(self) -> None:
        self.assertEqual(list(compose_config()["services"]), [SERVICE])
        self.assertEqual(list(self.overlay()["services"]), [SERVICE, "traefik"])

    def test_traefik_is_the_acceptances_traefik_pinned_by_digest(self) -> None:
        image = self.overlay()["services"]["traefik"]["image"]
        acceptance = yaml.safe_load((ACCEPTANCE / "compose.yml").read_text())["services"]["traefik"]["image"]

        self.assertRegex(image, r"^traefik:v3\.7\.\d+@sha256:[0-9a-f]{64}$")
        self.assertEqual(image, acceptance)

    def test_traefik_has_no_more_than_it_needs(self) -> None:
        traefik = self.overlay()["services"]["traefik"]

        # (Not read_only: Compose copies the inline route into the container, which a read-only root refuses.)
        self.assertEqual(traefik["cap_drop"], ["ALL"])
        self.assertEqual(traefik["cap_add"], ["NET_BIND_SERVICE"])
        self.assertIn("no-new-privileges:true", traefik["security_opt"])
        self.assertEqual(traefik["restart"], "unless-stopped")
        self.assertEqual(sorted(port["published"] for port in traefik["ports"]), ["443", "80"])
        # Routes come from a file, not from the Docker provider: Traefik gets no Docker socket.
        self.assertEqual([volume["target"] for volume in traefik["volumes"]], ["/letsencrypt"])
        self.assertFalse(any("docker" in flag for flag in traefik["command"] if flag.startswith("--providers")))

    def test_the_proxy_timeouts_are_the_acceptances_and_the_documented_ones(self) -> None:
        timeouts = self.flags(self.overlay(), "entrypoints.websecure.transport.respondingtimeouts.")
        acceptance = yaml.safe_load((ACCEPTANCE / "traefik.yml").read_text())["entryPoints"]["web"]["transport"]["respondingTimeouts"]

        self.assertEqual(
            {name.rsplit(".", 1)[1]: value for name, value in timeouts.items()},
            {name.lower(): value for name, value in acceptance.items()},
        )
        self.assertEqual(timeouts["entrypoints.websecure.transport.respondingtimeouts.readtimeout"], "1800s")  # 1 GiB at 5 Mbit/s
        # The operator can size it for a larger MAX_UPLOAD_BYTES or a slower link in the same .env.
        longer = self.flags(self.overlay(PROXY_READ_TIMEOUT="3600s"), "entrypoints.websecure.transport.respondingtimeouts.")
        self.assertEqual(longer["entrypoints.websecure.transport.respondingtimeouts.readtimeout"], "3600s")

    def test_the_route_sends_the_host_to_the_module_over_tls_with_hsts(self) -> None:
        config = self.overlay()
        routes = yaml.safe_load(config["configs"]["traefik_dynamic"]["content"])["http"]
        router = routes["routers"]["module"]
        resolvers = {name.split(".")[1] for name in self.flags(config, "certificatesresolvers.")}

        self.assertEqual(router["rule"], "Host(`module.example.test`)")
        self.assertEqual(router["entryPoints"], ["websecure"])
        self.assertEqual({router["tls"]["certResolver"]}, resolvers)
        # The service is the module's own, on the port the base file exposes.
        self.assertEqual(routes["services"]["module"]["loadBalancer"]["servers"], [{"url": f"http://{SERVICE}:3001"}])
        self.assertEqual(compose_config()["services"][SERVICE]["expose"], ["3001"])
        self.assertGreaterEqual(routes["middlewares"][router["middlewares"][0]]["headers"]["stsSeconds"], 31536000)
        self.assertRegex(self.flags(config, "entrypoints.web.")["entrypoints.web.http.redirections.entrypoint.scheme"], "https")


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
