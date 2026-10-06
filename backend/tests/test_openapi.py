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
from types import SimpleNamespace
from urllib.parse import urlsplit
from unittest import mock

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "http://localhost:3002")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")

import httpx  # noqa: E402
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
        cls.components = cls.document["components"]

    def test_every_route_of_the_app_and_every_allowlist_entry_is_in_the_file_and_nothing_else(self) -> None:
        expected = {
            (method, route.path_format)
            for route in http_routes()
            if route.path_format != CATCH_ALL
            for method in route.methods
        }
        expected |= {(method, template) for methods, template in main.PROXY_ROUTES for method in methods}

        self.assertEqual(set(self.operations), expected)
        self.assertGreater(len(expected), 30)

    def test_the_live_socket_is_not_in_it(self) -> None:
        self.assertEqual([path for path in self.document["paths"] if path.startswith("/api/live")], [])

    def test_operation_ids_are_unique(self) -> None:
        ids = [operation["operationId"] for operation in self.operations.values()]

        self.assertEqual(len(ids), len(set(ids)))

    def test_health_titles_distinguish_the_path_and_response_body(self) -> None:
        titles = {
            (method, path): self.operations[(method, path)]["summary"]
            for method in ("GET", "HEAD")
            for path in ("/health", "/api/healthz")
        }
        self.assertEqual(len(set(titles.values())), 4, "API navigation must distinguish all four health operations")
        for (_, path), title in titles.items():
            self.assertIn(path, title)

    def references(self) -> list[str]:
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
        return found

    def test_every_reference_resolves(self) -> None:
        found = self.references()
        for reference in found:
            with self.subTest(reference=reference):
                node = self.document
                for part in reference.removeprefix("#/").split("/"):
                    node = node[part]
        self.assertGreater(len(found), 100)

    def test_the_titles_and_the_response_descriptions_are_plain_text(self) -> None:
        # The reference shows these as written, with no Markdown: a backtick is a backtick.
        titles = [self.document["info"]["title"], *(tag["name"] for tag in self.document["tags"])]
        titles += [operation["summary"] for operation in self.operations.values()]
        for operation in self.operations.values():
            titles += [
                response["description"] for response in operation["responses"].values() if "description" in response
            ]
        titles += [response["description"] for response in self.components["responses"].values()]

        self.assertEqual([title for title in titles if "`" in title], [])
        self.assertGreater(len(titles), 150)

    def test_the_server_is_the_modules_own_address_and_not_an_address_that_looks_real(self) -> None:
        for server in self.document["servers"]:
            self.assertEqual(urlsplit(server["url"]).netloc, "", server["url"])

    def test_every_component_is_used(self) -> None:
        used = set(self.references())
        for kind in ("schemas", "responses", "parameters"):
            unused = [name for name in self.components[kind] if f"#/components/{kind}/{name}" not in used]

            self.assertEqual(unused, [], f"components.{kind} that nothing refers to")

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
    """The module's client, in process: every call is answered at once with the one answer it was given, or fails."""

    def __init__(
        self,
        status_code: int = 200,
        content: bytes = b"{}",
        content_type: str = "application/json",
        failure: Exception | None = None,
    ) -> None:
        self.answer = SimpleNamespace(
            status_code=status_code,
            headers={"content-type": content_type},
            content=content,
            json=lambda: json.loads(content),
        )
        self.failure = failure

    async def request(self, **kwargs):
        if self.failure:
            raise self.failure
        return self.answer

    async def post(self, url, **kwargs):
        return await self.request()


class AppCase(unittest.TestCase):
    """The app with a signed-in session and an Eneo that answers, and the file that describes it."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.document = json.loads(COMMITTED.read_text())
        cls.operations = operations(cls.document)
        cls.components = cls.document["components"]

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

    def call(
        self,
        method: str,
        path: str,
        *,
        session: bool = True,
        origin: str | None = None,
        user: str | None = None,
        files: dict | None = None,
    ):
        client = TestClient(main.app, raise_server_exceptions=False, follow_redirects=False)
        if session:
            client.cookies.set(SESSION_COOKIE, self.session)
        headers = {}
        if origin is not None:
            headers["Origin"] = origin
        if user is not None:
            headers["X-Expected-User"] = user
        url = re.sub(r"\{(\w+)\}", lambda match: "light" if match[1] == "variant" else "x", path)
        return client.request(method, url, headers=headers, files=files)

    def resolve(self, node: dict) -> dict:
        while "$ref" in node:
            target = self.document
            for part in node["$ref"].removeprefix("#/").split("/"):
                target = target[part]
            node = target
        return node

    def conforms(self, value: object, schema: dict) -> bool:
        """Whether ``value`` is what ``schema`` allows: anyOf, type, required and properties are all the file uses."""
        schema = self.resolve(schema)
        if "anyOf" in schema:
            return any(self.conforms(value, branch) for branch in schema["anyOf"])
        kinds = {"object": dict, "string": str, "integer": int, "boolean": bool, "array": list, "null": type(None)}
        types = schema.get("type", [])
        types = [types] if isinstance(types, str) else types
        if types and not any(isinstance(value, kinds[kind]) for kind in types):
            return False
        if isinstance(value, dict):
            if any(name not in value for name in schema.get("required", [])):
                return False
            return all(
                self.conforms(value[name], branch)
                for name, branch in schema.get("properties", {}).items()
                if name in value
            )
        return True

    def assert_described(self, method: str, path: str, response) -> None:
        """The answer is one the operation's response for its status (or its default) allows, by media type and body."""
        responses = self.operations[(method, path)]["responses"]
        entry = self.resolve(responses.get(str(response.status_code), responses.get("default", {})))
        media = response.headers["content-type"].split(";")[0]
        content = entry.get("content", {})
        self.assertTrue(content, f"{response.status_code} has no content in the file")
        described = content.get(media, content.get("*/*"))
        self.assertIsNotNone(described, f"{response.status_code} has no {media} or */* in the file: {sorted(content)}")
        body = response.json() if media == "application/json" else response.text
        self.assertTrue(
            self.conforms(body, described["schema"]), f"{response.status_code} {body!r} is not what the file allows"
        )

    @staticmethod
    def parameter_names(operation: dict) -> set[str]:
        return {
            parameter["$ref"].rsplit("/", 1)[-1] if "$ref" in parameter else parameter["name"]
            for parameter in operation.get("parameters", [])
        }


class WhoMayCallTests(AppCase):
    """Each operation requires what the file says it requires: a session, the module's origin, the page's user."""

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


class AnswerTests(AppCase):
    """What the app answers is what the file says it answers."""

    def test_the_branding_answer_is_one_the_file_describes_with_an_organisation_and_without(self) -> None:
        shown = self.components["schemas"]["Branding"]["properties"]["organization"]["anyOf"]
        organization = self.components["schemas"]["Organization"]

        self.assertIn({"type": "null"}, shown)
        self.assertIn({"$ref": "#/components/schemas/Organization"}, shown)
        for chosen in (main.settings.organization, None):
            with mock.patch.object(main.settings, "organization", chosen):
                body = self.call("GET", "/api/branding", session=False).json()

            self.assertEqual(set(body), {"organization"})
            if chosen is None:
                self.assertIsNone(body["organization"])
            else:
                self.assertLessEqual(set(organization["required"]), set(body["organization"]))
                self.assertLessEqual(set(body["organization"]), set(organization["properties"]))

    def test_what_eneo_answers_comes_back_as_its_own_and_the_file_allows_it(self) -> None:
        upload = {"upload_file": ("meeting.webm", b"audio", "audio/webm")}
        files = "/api/eneo/flows/{flow_id}/steps/{step_id}/runtime-files/"
        runs = "/api/eneo/flows/{flow_id}/runs/"
        cancel = "/api/eneo/flows/{flow_id}/runs/{run_id}/cancel/"
        as_json, as_text = "application/json", "text/plain"
        cases = (
            ("GET", "/api/eneo/flows/", None, 200, b'{"items": []}', as_json),
            ("GET", "/api/eneo/flows/", None, 200, b"plain text", as_text),
            ("GET", "/api/eneo/flows/", None, 400, b'{"errors": ["limit"]}', as_json),
            ("GET", "/api/eneo/flows/", None, 401, b'{"message": "token"}', as_json),
            ("GET", "/api/eneo/flows/", None, 404, b'{"detail": "Not found"}', as_json),
            ("GET", "/api/eneo/flows/", None, 502, b"Bad Gateway", as_text),
            ("POST", runs, None, 201, b'{"id": "run-1"}', as_json),
            ("POST", cancel, None, 409, b'{"code": "revision"}', as_json),
            ("POST", files, upload, 200, b'{"id": "file-1"}', as_json),
            ("POST", files, upload, 400, b'{"errors": ["too big"]}', as_json),
            ("POST", files, upload, 413, b'{"message": "too large"}', as_json),
            ("POST", files, upload, 422, b'{"detail": "Unsupported"}', as_json),
            ("POST", files, upload, 502, b'{"message": "bad gateway"}', as_json),
            ("POST", files, upload, 504, b"Gateway Timeout", as_text),
        )
        for method, path, body, status, content, content_type in cases:
            with self.subTest(method=method, path=path, status=status, content_type=content_type):
                main.http_client = Eneo(status, content, content_type)

                response = self.call(method, path, origin=main.settings.module_origin, user="user-id", files=body)

                self.assertEqual((response.status_code, response.content), (status, content))
                self.assertEqual(response.headers["content-type"].split(";")[0], content_type)
                self.assert_described(method, path, response)

    def test_what_the_module_answers_itself_is_what_the_file_allows(self) -> None:
        unreachable = Eneo(failure=httpx.ConnectError("no route"))
        cases = (
            ("GET", "/api/eneo/flows/", {"user": "someone-else"}, Eneo(), 409),
            ("GET", "/api/eneo/flows/", {}, unreachable, 502),
            (
                "POST",
                "/api/eneo/flows/{flow_id}/steps/{step_id}/runtime-files/",
                {"files": {"upload_file": ("a", b"", "text/plain")}},
                unreachable,
                502,
            ),
            (
                "POST",
                "/api/eneo/flows/{flow_id}/steps/{step_id}/runtime-files/",
                {"origin": "https://elsewhere.example"},
                Eneo(),
                403,
            ),
            ("POST", "/api/eneo/flows/{flow_id}/steps/{step_id}/runtime-files/", {"session": False}, Eneo(), 401),
            ("POST", "/api/eneo/flows/{flow_id}/steps/{step_id}/runtime-files/", {}, Eneo(), 400),
        )
        for method, path, options, eneo, status in cases:
            with self.subTest(method=method, path=path, status=status, options=sorted(options)):
                main.http_client = eneo
                options = {"origin": main.settings.module_origin, "user": "user-id", **options}

                response = self.call(method, path, **options)

                self.assertEqual(response.status_code, status, response.text)
                self.assert_described(method, path, response)

    def test_what_eneo_refuses_a_file_with_comes_back_in_detail_and_the_file_allows_it(self) -> None:
        for path in (
            "/api/eneo/flows/{flow_id}/runs/{run_id}/input-files/{file_id}/audio",
            "/api/eneo/flows/{flow_id}/runs/{run_id}/artifacts/{file_id}/content",
        ):
            for status in (401, 404, 413, 502):
                with self.subTest(path=path, status=status):
                    main.http_client = Eneo(status, b'{"message": "no"}')

                    response = self.call("GET", path)

                    self.assertEqual((response.status_code, response.json()), (status, {"detail": {"message": "no"}}))
                    self.assert_described("GET", path, response)


if __name__ == "__main__":
    unittest.main()
