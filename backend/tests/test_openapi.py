"""docs/api/openapi.json describes the backend as it is, and says nothing the backend does not do.

The file is written by backend/export_openapi.py from the app's own schema generator. The first test holds it to a
fresh export, made the way a person makes it (the script, in a process of its own, with no settings in the environment,
twice). The others hold what it says to the app: every route and allowlist entry is in it, each reference resolves, each
error code the backend sends is in it, and who it says may call an operation is who may.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "http://localhost:3002")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.module_auth import SESSION_COOKIE, EneoSsoSession, ModuleUser  # noqa: E402
from app_routes import http_routes  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1]
COMMITTED = BACKEND.parent / "docs" / "api" / "openapi.json"
CATCH_ALL = "/api/eneo/{path}"
METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")


def operations(document: dict) -> dict[tuple[str, str], dict]:
    return {
        (method.upper(), path): operation
        for path, item in document["paths"].items()
        for method, operation in item.items()
        if method in METHODS
    }


# What a shell that runs a deployment, or a developer's own, can have set: none of it is the export's to read.
INHERITED = {
    "ENEO_API_KEY": "the-deployments",
    "ENEO_API_KEY_HEADER_NAME": "X-Their-Key",
    "COOKIE_SECURE": "false",
    "MODULE_KEY": "their-module",
    "MAX_UPLOAD_BYTES": "1000",
    "STATIC_DIR": "/srv/web",
    "SHOW_ORGANIZATION": "false",
    "ORGANIZATION_NAME": "Umeå kommun",
    "ORGANIZATION_ACCENT": "not a colour",
}


def export(seed: str, destination: Path, inherited: dict[str, str] | None = None) -> bytes:
    """What ``python export_openapi.py`` writes, run as a person runs it: nothing of the settings in its environment."""
    result = subprocess.run(
        [sys.executable, "export_openapi.py", str(destination)],
        cwd=BACKEND,
        env={"PATH": os.environ["PATH"], "PYTHONHASHSEED": seed, **(inherited or {})},
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return destination.read_bytes()


class FreshExportTests(unittest.TestCase):
    def test_the_committed_file_is_what_the_script_writes_whatever_the_hash_seed(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            first = export("1", Path(folder) / "first.json")
            second = export("2", Path(folder) / "second.json")

        self.assertEqual(first, second, "the export differs between two runs: something in it is ordered by chance")
        self.assertEqual(
            COMMITTED.read_bytes(),
            first,
            "docs/api/openapi.json is not what the app says: run `python export_openapi.py` in backend/ and commit it",
        )

    def test_settings_inherited_from_the_shell_do_not_reach_the_export(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            exported = export("3", Path(folder) / "inherited.json", INHERITED)

        self.assertEqual(COMMITTED.read_bytes(), exported)


class DocumentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.document = json.loads(COMMITTED.read_text())
        cls.operations = operations(cls.document)

    def test_every_route_of_the_app_and_every_allowlist_entry_is_in_the_file_and_nothing_else(self) -> None:
        expected = {
            (method, route.path_format)
            for route in http_routes()
            if route.path_format != CATCH_ALL
            for method in route.methods
        }
        expected |= {(method, template) for methods, template in main.PROXY_ROUTES for method in methods}

        self.assertEqual(set(self.operations), expected)
        self.assertGreater(len(expected), 40)

    def test_the_live_socket_is_not_in_it(self) -> None:
        self.assertEqual([path for path in self.document["paths"] if path.startswith("/api/live")], [])

    def test_operation_ids_are_unique(self) -> None:
        ids = [operation["operationId"] for operation in self.operations.values()]

        self.assertEqual(len(ids), len(set(ids)))

    def test_every_reference_resolves(self) -> None:
        found = []

        def walk(node: object) -> None:
            if isinstance(node, dict):
                if "$ref" in node:
                    found.append(node["$ref"])
                for value in node.values():
                    walk(value)
            elif isinstance(node, list):
                for value in node:
                    walk(value)

        walk(self.document)
        for reference in found:
            with self.subTest(reference=reference):
                node = self.document
                for part in reference.removeprefix("#/").split("/"):
                    node = node[part]
        self.assertGreater(len(found), 100)

    def test_every_error_code_the_backend_sends_is_in_the_file(self) -> None:
        sent = set(re.findall(r'"error": "(\w+)"', (BACKEND / "app" / "main.py").read_text()))

        self.assertEqual(set(self.document["components"]["schemas"]["BffError"]["properties"]["error"]["enum"]), sent)

    def test_every_eneo_operation_names_the_eneo_path_it_forwards_to(self) -> None:
        for (method, path), operation in self.operations.items():
            if path.startswith("/api/eneo/") and operation["tags"] == ["Eneo"]:
                with self.subTest(method=method, path=path):
                    self.assertIn(
                        "{ENEO_BACKEND_URL}/api/v1/" + path.removeprefix("/api/eneo/"), operation["description"]
                    )


class Eneo:
    """The module's client, in process: every call is answered at once with an empty JSON object."""

    class Answer:
        status_code = 200
        headers = {"content-type": "application/json"}
        content = b"{}"

    async def request(self, **kwargs):
        return self.Answer()


class WhoMayCallTests(unittest.TestCase):
    """Each operation requires what the file says it requires: a session, the module's origin, the page's user."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.operations = operations(json.loads(COMMITTED.read_text()))

    def setUp(self) -> None:
        main.module_auth.sessions.clear()
        self.addCleanup(setattr, main, "http_client", main.http_client)
        main.http_client = Eneo()
        self.session = main.module_auth.sessions.create(
            EneoSsoSession(
                access_token="module-user-token",
                expires_at=int(time.time()) + 600,
                refresh_at=int(time.time()) + 300,
                session_expires_at=int(time.time()) + 3600,
                module_key="speech-to-text",
                tenant_id="tenant-id",
                user=ModuleUser(id="user-id", email="user@example.test"),
            )
        )

    def call(self, method: str, path: str, *, session: bool = True, origin: str | None = None, user: str | None = None):
        client = TestClient(main.app, raise_server_exceptions=False, follow_redirects=False)
        if session:
            client.cookies.set(SESSION_COOKIE, self.session)
        headers = {}
        if origin is not None:
            headers["Origin"] = origin
        if user is not None:
            headers["X-Expected-User"] = user
        url = re.sub(r"\{(\w+)\}", lambda match: "light" if match[1] == "variant" else "x", path)
        return client.request(method, url, headers=headers)

    @staticmethod
    def parameter_names(operation: dict) -> set[str]:
        return {
            parameter["$ref"].rsplit("/", 1)[-1] if "$ref" in parameter else parameter["name"]
            for parameter in operation.get("parameters", [])
        }

    def test_an_operation_with_a_security_requirement_answers_401_without_a_session_and_one_without_does_not(
        self,
    ) -> None:
        for (method, path), operation in self.operations.items():
            with self.subTest(method=method, path=path):
                # Origin and user named, so that only the session is missing.
                response = self.call(method, path, session=False, origin=main.settings.module_origin, user="user-id")

                self.assertEqual(response.status_code == 401, "security" in operation, response.text)
                if "security" in operation:
                    self.assertEqual(response.headers["x-auth-required"], "session")

    def test_an_operation_that_names_the_origin_answers_403_for_another_one(self) -> None:
        for (method, path), operation in self.operations.items():
            if "Origin" in self.parameter_names(operation):
                with self.subTest(method=method, path=path):
                    response = self.call(method, path, origin="https://attacker.example.test", user="user-id")

                    self.assertEqual(response.status_code, 403)
                    self.assertEqual(response.json(), {"detail": "Invalid request origin"})

    def test_an_operation_that_changes_something_in_eneo_names_the_origin_and_the_user_and_a_read_does_not_need_either(
        self,
    ) -> None:
        for (method, path), operation in self.operations.items():
            if path.startswith("/api/eneo/") and "security" in operation:
                names = self.parameter_names(operation)
                with self.subTest(method=method, path=path):
                    self.assertEqual("Origin" in names, method != "GET")
                    self.assertEqual("ExpectedUser" in names, method != "GET")
                    self.assertEqual(
                        "ExpectedUserOptional" in names,
                        method == "GET" and "audio" not in path and "content" not in path,
                    )

    def test_an_operation_with_a_required_user_answers_409_without_one_and_for_another(self) -> None:
        for (method, path), operation in self.operations.items():
            if "ExpectedUser" in self.parameter_names(operation):
                for user in (None, "someone-else"):
                    with self.subTest(method=method, path=path, user=user):
                        response = self.call(method, path, origin=main.settings.module_origin, user=user)

                        self.assertEqual(response.status_code, 409)
                        self.assertEqual(response.json(), {"detail": "user_changed"})
                        self.assertIn("409", operation["responses"])

    def test_an_operation_that_may_name_the_user_answers_409_for_another_and_not_for_none(self) -> None:
        for (method, path), operation in self.operations.items():
            if "ExpectedUserOptional" in self.parameter_names(operation):
                with self.subTest(method=method, path=path):
                    response = self.call(method, path, user="someone-else")

                    self.assertEqual(response.status_code, 409)
                    self.assertEqual(response.json(), {"detail": "user_changed"})
                    self.assertIn("409", operation["responses"])
                    self.assertEqual(self.call(method, path).status_code, 200)


if __name__ == "__main__":
    unittest.main()
