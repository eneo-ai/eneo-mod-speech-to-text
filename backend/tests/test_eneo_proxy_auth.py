import os
import time
import unittest

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "http://localhost:3002")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.module_auth import (  # noqa: E402
    EneoSsoSession,
    ModuleUser,
    SESSION_COOKIE,
)


class FakeResponse:
    content = b'{"items":[]}'
    status_code = 200
    headers = {"content-type": "application/json"}


class FakeProxyClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def request(self, **kwargs):
        self.calls.append(kwargs)
        return FakeResponse()


class ProxyCase(unittest.TestCase):
    """A signed-in browser of the module, and an Eneo that answers every call it gets."""

    def setUp(self) -> None:
        self.original_client = main.http_client
        self.proxy_client = FakeProxyClient()
        main.http_client = self.proxy_client
        self.client = TestClient(main.app)
        self.client.headers["X-Expected-User"] = "user-id"  # the page names the user it was opened for
        session = EneoSsoSession(
            access_token="module-user-token",
            expires_at=int(time.time()) + 60,
            refresh_at=int(time.time()) + 30,
            session_expires_at=int(time.time()) + 3600,
            module_key="speech-to-text",
            tenant_id="tenant-id",
            user=ModuleUser(id="user-id", email="user@example.test"),
        )
        main.module_auth.sessions.clear()
        session_id = main.module_auth.sessions.create(session)
        self.client.cookies.set(
            SESSION_COOKIE,
            session_id,
        )

    def tearDown(self) -> None:
        main.http_client = self.original_client


class EneoProxyAuthTests(ProxyCase):
    def test_proxy_replaces_browser_credentials_with_module_credentials(self) -> None:
        response = self.client.get(
            "/api/eneo/flows/?published=true",
            headers={
                "Authorization": "Bearer browser-controlled-token",
                "X-API-Key": "browser-controlled-key",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.proxy_client.calls), 1)
        call = self.proxy_client.calls[0]
        self.assertEqual(
            call["url"],
            "https://eneo.example.test/api/v1/flows/",
        )
        self.assertEqual(call["params"]["published"], "true")
        self.assertEqual(call["headers"]["X-API-Key"], "test-key")
        self.assertEqual(
            call["headers"]["Authorization"],
            "Bearer module-user-token",
        )

    def test_mutation_rejects_cross_origin_request_before_proxying(self) -> None:
        response = self.client.post(
            "/api/eneo/flows/flow-id/runs/",
            headers={"Origin": "https://attacker.example.test"},
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_proxy_never_forwards_the_browsers_origin_to_eneo(self) -> None:
        # The module checks the browser's Origin itself. Eneo refuses any origin it does not
        # list, so passing the module's own hostname on would fail every write in production.
        response = self.client.post(
            "/api/eneo/flows/flow-1/runs/run-1/steps/step-1/transcript-regenerations/",
            headers={
                "Origin": "http://localhost:3002",
                "Referer": "http://localhost:3002/flows/flow-1",
            },
            json={"expected_run_revision": 2, "expected_correction_revision": None, "segments_hash": "a" * 64},
        )

        self.assertEqual(response.status_code, 200)
        forwarded = {name.lower() for name in self.proxy_client.calls[0]["headers"]}
        self.assertNotIn("origin", forwarded)
        self.assertNotIn("referer", forwarded)

    def test_proxy_exposes_transcript_review_routes(self) -> None:
        base = "/api/eneo/flows/flow-1/runs/run-1"
        for method, path in (
            ("GET", f"{base}/status/"),
            ("GET", f"{base}/steps/step-1/transcript-words/"),
            ("GET", f"{base}/transcript-corrections/"),
            ("PATCH", f"{base}/steps/step-1/transcript-corrections/"),
            # Eneo keeps an attempt's segments here, paged; the step result does not embed them.
            ("GET", f"{base}/steps/step-1/attempts/1/transcript-source/?start_segment_index=200"),
        ):
            response = self.client.request(
                method,
                path,
                headers={"Origin": "http://localhost:3002"},
                json={} if method == "PATCH" else None,
            )
            self.assertEqual(response.status_code, 200, f"{method} {path}")
        self.assertEqual(len(self.proxy_client.calls), 5)

    def test_proxy_forwards_flow_discovery_across_the_users_spaces(self) -> None:
        response = self.client.get("/api/eneo/flows/?published_only=true&limit=200&offset=0")

        self.assertEqual(response.status_code, 200)
        call = self.proxy_client.calls[0]
        self.assertEqual(call["url"], "https://eneo.example.test/api/v1/flows/")
        self.assertEqual(dict(call["params"]), {"published_only": "true", "limit": "200", "offset": "0"})

    def test_proxy_does_not_expose_spaces(self) -> None:
        # Discovery lists flows across spaces; the spaces routes refuse module credentials anyway.
        for path in ("/api/eneo/spaces/", "/api/eneo/spaces/space-1/"):
            self.assertEqual(self.client.get(path).status_code, 403, path)
        self.assertEqual(self.proxy_client.calls, [])

    def test_proxy_never_hands_the_browser_a_signed_url(self) -> None:
        # A signed URL is a bearer credential for a file. Only the module backend mints one, and streams the file; the
        # generic proxy returns Eneo's body unchanged, so a route that mints one would give it to the browser.
        for path in (
            "/api/eneo/flows/flow-1/template-files/file-1/signed-url/",
            "/api/eneo/flows/flow-1/template-files/file-1/signed-url",
            "/api/eneo/flows/flow-1/runs/run-1/input-files/file-1/signed-url/",
            "/api/eneo/flows/flow-1/runs/run-1/artifacts/file-1/signed-url/",
        ):
            for method in ("POST", "GET"):
                with self.subTest(method=method, path=path):
                    response = self.client.request(
                        method, path, headers={"Origin": "http://localhost:3002"}, json={"expires_in": 3600} if method == "POST" else None
                    )

                    self.assertEqual(response.status_code, 403)
                    self.assertEqual(response.json()["detail"], "Eneo resource is not exposed")
        self.assertEqual(self.proxy_client.calls, [], "Eneo was asked for something")

    def test_proxy_exposes_transcript_regeneration_with_its_idempotency_key(self) -> None:
        # "Skapa dokumentet igen med rättningarna" starts a new run from the reviewed transcript.
        response = self.client.post(
            "/api/eneo/flows/flow-1/runs/run-1/steps/step-1/transcript-regenerations/",
            headers={
                "Origin": "http://localhost:3002",
                "Idempotency-Key": "transcript-regeneration:run-1:3",
            },
            json={"expected_run_revision": 2, "expected_correction_revision": 3, "segments_hash": "a" * 64},
        )

        self.assertEqual(response.status_code, 200)
        call = self.proxy_client.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(
            call["url"],
            "https://eneo.example.test/api/v1/flows/flow-1/runs/run-1/steps/step-1/transcript-regenerations/",
        )
        self.assertEqual(call["headers"]["idempotency-key"], "transcript-regeneration:run-1:3")
        # Only POST: listing or deleting regenerations is not the module's to expose.
        self.assertEqual(
            self.client.get("/api/eneo/flows/flow-1/runs/run-1/steps/step-1/transcript-regenerations/").status_code,
            403,
        )

    def test_proxy_exposes_retry_from_the_failed_step_with_its_idempotency_key(self) -> None:
        response = self.client.post(
            "/api/eneo/flows/flow-1/runs/run-1/retry/",
            headers={
                "Origin": "http://localhost:3002",
                "Idempotency-Key": "flow-run-retry:run-1",
            },
        )

        self.assertEqual(response.status_code, 200)
        call = self.proxy_client.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["url"], "https://eneo.example.test/api/v1/flows/flow-1/runs/run-1/retry/")
        self.assertEqual(call["headers"]["idempotency-key"], "flow-run-retry:run-1")

    def test_proxy_refuses_a_path_that_is_not_listed_whatever_its_slash(self) -> None:
        response = self.client.get("/api/eneo/users")

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_proxy_rejects_resource_outside_module_allowlist(self) -> None:
        response = self.client.post(
            "/api/eneo/users/",
            headers={"Origin": "http://localhost:3002"},
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_proxy_rejects_encoded_dot_segment_traversal(self) -> None:
        # `%2E%2E` survives ASGI path normalization and decodes to `..`, which
        # would resolve upstream to /api/v1/flows/../runs/ -> /api/v1/runs/.
        response = self.client.get("/api/eneo/flows/%2E%2E/runs/")

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_proxy_rejects_single_dot_segment(self) -> None:
        response = self.client.get("/api/eneo/flows/%2E/runs/")

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_proxy_rejects_an_encoded_query_or_fragment_in_a_segment(self) -> None:
        # `flows/x%3F/runs/` matches the allowlist but would reach
        # /api/v1/flows/x upstream, with the rest moved into the query.
        for path in ("/api/eneo/flows/x%3F/runs/", "/api/eneo/flows/x%23/runs/"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 403, path)
        response = self.client.post(
            "/api/eneo/flows/x%3F/steps/s/runtime-files/",
            headers={"Origin": "http://localhost:3002"},
            files={"upload_file": ("meeting.webm", b"audio", "audio/webm")},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_upload_route_rejects_dot_segment_flow_id(self) -> None:
        response = self.client.post(
            "/api/eneo/flows/%2E%2E/steps/s/runtime-files/",
            headers={"Origin": "http://localhost:3002"},
            files={"upload_file": ("meeting.webm", b"audio", "audio/webm")},
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])


FLOW, RUN, STEP, ATTEMPT, CHECKPOINT = "flow-1", "run-1", "step-1", "attempt-1", "checkpoint-1"
RUN_PATH = f"flows/{FLOW}/runs/{RUN}"
STEP_PATH = f"{RUN_PATH}/steps/{STEP}"
CHECKPOINT_PATH = f"{RUN_PATH}/review-checkpoints/{CHECKPOINT}"

# Every call the module forwards to Eneo, as the page spells it. Written out, not read from the allowlist: this is what the
# allowlist is held to.
ALLOWED = (
    ("GET", "flows/"),
    ("GET", f"flows/{FLOW}/published/"),
    ("GET", f"flows/{FLOW}/run-contract/"),
    ("GET", f"flows/{FLOW}/graph/"),
    ("GET", f"flows/{FLOW}/runs/"),
    ("POST", f"flows/{FLOW}/runs/"),
    ("GET", f"{RUN_PATH}/"),
    ("GET", f"{RUN_PATH}/status/"),
    ("GET", f"{RUN_PATH}/steps/"),
    ("GET", f"{STEP_PATH}/transcript-words/"),
    ("GET", f"{RUN_PATH}/transcript-corrections/"),
    ("GET", f"{STEP_PATH}/attempts/{ATTEMPT}/transcript-source/"),
    ("PATCH", f"{STEP_PATH}/transcript-corrections/"),
    ("POST", f"{RUN_PATH}/cancel/"),
    ("POST", f"{RUN_PATH}/retry/"),
    ("POST", f"{STEP_PATH}/transcript-regenerations/"),
    ("GET", f"{RUN_PATH}/review-checkpoints/active/"),
    ("PATCH", f"{CHECKPOINT_PATH}/"),
    ("POST", f"{CHECKPOINT_PATH}/approve/"),
    ("POST", f"{CHECKPOINT_PATH}/reject/"),
    ("POST", f"{CHECKPOINT_PATH}/resume/"),
)

# Calls the allowlist does not own, and so is not held to above: an id of a checkpoint may be spelled "active".
ELSEWHERE = (("PATCH", f"{RUN_PATH}/review-checkpoints/active/"),)

# Uploads have routes of their own, which take a POST; no other method of theirs is forwarded.
UPLOAD_PATHS = (f"flows/{FLOW}/steps/{STEP}/runtime-files/",)

# Paths next to the allowed ones that no method may reach, spelled as a page could send them.
REFUSED = (
    "",
    # Eneo has these, and the module's page calls none of them.
    f"{RUN_PATH}/redispatch/",
    f"{STEP_PATH}/rerun/",
    f"{RUN_PATH}/evidence/",
    f"{RUN_PATH}/evidence/export",
    f"flows/{FLOW}/template-files/",
    "flows",
    f"flows/{FLOW}/",
    f"flows/{FLOW}/runs/{RUN}/steps/{STEP}/",
    f"flows/{FLOW}/published/extra/",
    f"{RUN_PATH}/status/extra/",
    f"{STEP_PATH}/transcript-words/extra/",
    f"{STEP_PATH}/attempts/{ATTEMPT}/",
    f"{RUN_PATH}/cancel/extra/",
    f"{RUN_PATH}/evidence/other",
    f"{RUN_PATH}/evidence/export/extra",
    f"{CHECKPOINT_PATH}/approve/extra/",
    f"{CHECKPOINT_PATH}/delete/",
    f"{RUN_PATH}/review-checkpoints/",
    f"{RUN_PATH}/artifacts/file-1/",
    f"{RUN_PATH}/input-files/file-1/",
    "flows//runs/",
    f"flows/{FLOW}/runs//",
    "x/flows/",
    "Flows/",
    "api/v1/flows/",
    "users/",
    "spaces/",
)

# Raw paths whose decoded form is listed or looks listed, and that the module refuses before it matches: a dot segment,
# a query or fragment hidden in an id, a separator inside an id, a backslash and the control characters. A line feed
# last in a path is not here: the router's pattern ends before it, so the path the module sees is the listed one without it.
UNSAFE = (
    "flows/%2E%2E/runs/",
    "flows/%2e/runs/",
    "flows/%2E%2e/published/",
    f"flows/{FLOW}%3F/runs/",
    f"flows/{FLOW}%23/runs/",
    f"flows/{FLOW}%2Fx/runs/",
    f"flows/{FLOW}%5Cx/runs/",
    "flows/%00/runs/",
)

OTHER_METHODS = ("GET", "POST", "PATCH")
ORIGIN = {"Origin": "http://localhost:3002"}


class EneoProxyAllowlistTests(ProxyCase):
    def send(self, method: str, path: str):
        return self.client.request(method, f"/api/eneo/{path}", headers=ORIGIN, json={} if method != "GET" else None)

    def allowed_methods(self, path: str) -> set[str]:
        return {method for method, listed in ALLOWED + ELSEWHERE if listed == path}

    def test_every_listed_call_reaches_eneo_as_the_same_method_and_path(self) -> None:
        for method, path in ALLOWED:
            with self.subTest(method=method, path=path):
                self.proxy_client.calls.clear()

                response = self.send(method, path)

                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    [(call["method"], call["url"]) for call in self.proxy_client.calls],
                    [(method, f"https://eneo.example.test/api/v1/{path}")],
                )

    def test_a_listed_path_is_refused_for_every_other_method(self) -> None:
        for _, path in ALLOWED:
            for method in sorted(set(OTHER_METHODS) - self.allowed_methods(path)):
                with self.subTest(method=method, path=path):
                    response = self.send(method, path)

                    self.assertEqual(response.status_code, 403)
                    self.assertEqual(response.json(), {"detail": "Eneo resource is not exposed"})
        self.assertEqual(self.proxy_client.calls, [])

    def test_the_slash_twin_of_a_listed_path_is_refused(self) -> None:
        for method, path in ALLOWED:
            twin = path[:-1] if path.endswith("/") else path + "/"
            with self.subTest(method=method, path=twin):
                response = self.send(method, twin)

                self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_a_path_next_to_the_listed_ones_is_refused_for_every_method(self) -> None:
        for path in REFUSED:
            for method in OTHER_METHODS:
                with self.subTest(method=method, path=path):
                    response = self.send(method, path)

                    self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_an_upload_path_is_forwarded_for_no_other_method(self) -> None:
        for path in UPLOAD_PATHS:
            for method in ("GET", "PATCH"):
                with self.subTest(method=method, path=path):
                    response = self.send(method, path)

                    self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_a_template_file_is_neither_uploaded_nor_listed(self) -> None:
        for method in ("GET", "POST", "PATCH"):
            with self.subTest(method=method):
                response = self.client.request(
                    method,
                    f"/api/eneo/flows/{FLOW}/template-files/",
                    headers=ORIGIN,
                    files={"upload_file": ("mall.docx", b"template", "application/octet-stream")}
                    if method == "POST"
                    else None,
                )

                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json(), {"detail": "Eneo resource is not exposed"})
        self.assertEqual(self.proxy_client.calls, [])

    def test_an_unsafe_spelling_of_a_listed_path_is_refused_for_every_method(self) -> None:
        for path in UNSAFE:
            for method in OTHER_METHODS:
                with self.subTest(method=method, path=path):
                    response = self.send(method, path)

                    self.assertEqual(response.status_code, 403)
        self.assertEqual(self.proxy_client.calls, [])

    def test_a_method_the_proxy_does_not_route_is_not_forwarded(self) -> None:
        for method in ("PUT", "DELETE"):
            with self.subTest(method=method):
                response = self.send(method, "flows/")

                self.assertEqual(response.status_code, 405)
        self.assertEqual(self.proxy_client.calls, [])


if __name__ == "__main__":
    unittest.main()
