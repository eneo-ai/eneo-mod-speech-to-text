"""The Helm chart (deploy/helm/eneo-mod-speech-to-text) runs what docker-compose.yml runs: the same image, the same variables
under the same names, the same hardening. helm renders it here; without helm the rendering tests are skipped, and CI has it."""

import re
import shutil
import subprocess
import unittest
from pathlib import Path

import yaml

REPOSITORY = Path(__file__).resolve().parents[2]
CHART = REPOSITORY / "deploy" / "helm" / "eneo-mod-speech-to-text"
CI_VALUES = REPOSITORY / "deploy" / "helm" / "ci-values.yaml"
IMAGE = "ghcr.io/eneo-ai/eneo-mod-speech-to-text"
# The chart sets these itself: the version from the image's tag, the two secrets from a Secret.
SET_BY_THE_CHART = ("MODULE_VERSION", "ENEO_API_KEY", "SESSION_SECRET")


def compose_variables() -> set[str]:
    return set(yaml.safe_load((REPOSITORY / "docker-compose.yml").read_text())["services"]["speech-to-text"]["environment"])


def helm_template(*args: str, values: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["helm", "template", "stt", str(CHART), *(["-f", str(CI_VALUES)] if values else []), *args], capture_output=True, text=True
    )


def render(*args: str) -> dict[str, dict]:
    """The chart rendered with CI's values and ``args``, by kind (it makes one of each)."""
    result = helm_template(*args)
    if result.returncode:
        raise AssertionError(result.stderr)
    return {document["kind"]: document for document in yaml.safe_load_all(result.stdout) if document}


def pod(objects: dict[str, dict]) -> dict:
    return objects["Deployment"]["spec"]["template"]["spec"]


def environment(objects: dict[str, dict]) -> dict[str, dict]:
    return {variable["name"]: variable for variable in pod(objects)["containers"][0]["env"]}


class ChartValuesTests(unittest.TestCase):
    def test_the_defaults_name_only_variables_compose_passes(self) -> None:
        defaults = yaml.safe_load((CHART / "values.yaml").read_text())["env"]

        self.assertLessEqual(set(defaults), compose_variables() - set(SET_BY_THE_CHART))


@unittest.skipUnless(shutil.which("helm"), "helm is required to render the chart (CI has it)")
class ChartTests(unittest.TestCase):
    def test_every_compose_variable_reaches_the_container_under_its_own_name_and_no_other(self) -> None:
        # CI's values set the addresses and the logo; every other variable is given a value here.
        given = sorted(compose_variables() - set(SET_BY_THE_CHART) - set(yaml.safe_load(CI_VALUES.read_text())["env"]))
        objects = render(*(arg for name in given for arg in ("--set-string", f"env.{name}=x")))

        self.assertEqual(set(environment(objects)), compose_variables())

    def test_an_empty_value_is_not_set_so_the_module_uses_its_default(self) -> None:
        # The backend refuses an empty number ("" is no integer); Compose's ${NAME:-default} gives the default.
        self.assertNotIn("MAX_UPLOAD_BYTES", environment(render("--set-string", "env.MAX_UPLOAD_BYTES=")))

    def test_the_image_is_the_charts_release_and_the_module_is_told_which(self) -> None:
        app_version = yaml.safe_load((CHART / "Chart.yaml").read_text())["appVersion"]

        for args, tag in (((), app_version), (("--set", "image.tag=v1.2.3"), "v1.2.3")):
            with self.subTest(tag=tag):
                objects = render(*args)
                self.assertEqual(pod(objects)["containers"][0]["image"], f"{IMAGE}:{tag}")
                self.assertEqual(environment(objects)["MODULE_VERSION"]["value"], tag)

    def test_one_replica_and_the_old_pod_stops_before_the_new_one_starts(self) -> None:
        spec = render()["Deployment"]["spec"]

        self.assertEqual((spec["replicas"], spec["strategy"]), (1, {"type": "Recreate"}))

    def test_the_pod_is_locked_down_as_compose_locks_the_container(self) -> None:
        user, group = re.search(r"(?m)^USER (\d+):(\d+)$", (REPOSITORY / "Dockerfile").read_text()).groups()
        spec = pod(render())
        container = spec["containers"][0]

        self.assertEqual(
            {key: spec["securityContext"][key] for key in ("runAsNonRoot", "runAsUser", "runAsGroup")},
            {"runAsNonRoot": True, "runAsUser": int(user), "runAsGroup": int(group)},
        )
        self.assertEqual(
            container["securityContext"],
            {"readOnlyRootFilesystem": True, "allowPrivilegeEscalation": False, "capabilities": {"drop": ["ALL"]}},
        )
        self.assertIs(spec["automountServiceAccountToken"], False)

    def test_tmp_is_the_nodes_disk_with_a_limit_and_the_only_writable_mount(self) -> None:
        spec = pod(render("--set", "spool.sizeLimit=5Gi"))
        volumes = {volume["name"]: volume for volume in spec["volumes"]}
        writable = [mount for mount in spec["containers"][0]["volumeMounts"] if not mount.get("readOnly")]

        self.assertEqual([mount["mountPath"] for mount in writable], ["/tmp"])
        # Not medium: Memory, which would hold every upload in RAM.
        self.assertEqual(volumes[writable[0]["name"]], {"name": "spool", "emptyDir": {"sizeLimit": "5Gi"}})

    def test_the_logo_configmap_is_mounted_read_only_where_organization_logo_points(self) -> None:
        objects = render()
        spec = pod(objects)
        mount = next(mount for mount in spec["containers"][0]["volumeMounts"] if mount["name"] == "branding")

        self.assertEqual(environment(objects)["ORGANIZATION_LOGO"]["value"], "/branding/logo.svg")
        self.assertEqual((mount["mountPath"], mount["readOnly"]), ("/branding", True))
        self.assertIn({"name": "branding", "configMap": {"name": "tal-till-text-logga"}}, spec["volumes"])
        self.assertNotEqual(helm_template("--set-string", "env.ORGANIZATION_LOGO=").returncode, 0)

    def test_the_secrets_come_from_the_charts_secret_or_an_existing_one(self) -> None:
        for args, name, made in (((), "stt", True), (("--set", "existingSecret=tal-till-text"), "tal-till-text", False)):
            with self.subTest(secret=name):
                objects = render(*args)
                references = {key: value["valueFrom"]["secretKeyRef"] for key, value in environment(objects).items() if "valueFrom" in value}
                self.assertEqual(references, {key: {"name": name, "key": key} for key in ("ENEO_API_KEY", "SESSION_SECRET")})
                self.assertEqual("Secret" in objects, made)
        self.assertNotEqual(helm_template("--set-string", "secret.SESSION_SECRET=").returncode, 0)

    def test_the_service_and_probes_use_3001_and_health(self) -> None:
        objects = render()
        container = pod(objects)["containers"][0]

        self.assertEqual(container["ports"], [{"name": "http", "containerPort": 3001}])
        self.assertEqual(objects["Service"]["spec"]["ports"], [{"name": "http", "port": 3001, "targetPort": "http"}])
        for probe in ("readinessProbe", "livenessProbe"):
            with self.subTest(probe=probe):
                self.assertEqual(container[probe]["httpGet"], {"path": "/health", "port": "http"})

    def test_the_ingress_routes_the_host_of_the_modules_public_address(self) -> None:
        ingress = render()["Ingress"]["spec"]

        self.assertEqual([rule["host"] for rule in ingress["rules"]], ["transkribering.example.org"])
        self.assertEqual(ingress["tls"], [{"hosts": ["transkribering.example.org"], "secretName": "tal-till-text-tls"}])
        self.assertNotIn("Ingress", render("--set", "ingress.enabled=false"))

    def test_the_chart_does_not_render_without_the_addresses(self) -> None:
        self.assertNotEqual(helm_template(values=False).returncode, 0)


if __name__ == "__main__":
    unittest.main()
