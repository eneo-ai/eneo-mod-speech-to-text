"""No route answers a redirect for the path as the frontend sends it, or for its slash twin.

Next stripped a trailing slash when it forwarded a request, so the backend never saw the one the frontend sends, and
Starlette answers a slash twin of a route with a 307 whose Location follows the scope's scheme: behind Traefik it says
http://, which a fetch on an https page refuses as mixed content. Now the backend sees the exact path, a twin that is
not a route is a JSON 404, and the slashless form of an allowlisted /api/eneo path is refused like any path not on the
list.
"""

import os
import re
import time
import unittest
from pathlib import Path

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "https://module.example.test")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("AUTH_MODE", "eneo_sso")

from fastapi.routing import APIRoute, APIWebSocketRoute  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.module_auth import SESSION_COOKIE, EneoSsoSession, ModuleUser  # noqa: E402

REPOSITORY = Path(__file__).resolve().parents[2]
REDIRECTS = {301, 302, 307, 308}
UUID = "00000000-0000-4000-8000-000000000001"
PARAMETER = re.compile(r"\{(\w+)(?::\w+)?\}")


class Eneo:
    """The module's client, in process: every call is answered at once with an empty JSON object (a real client would go to the network)."""

    class Answer:
        status_code = 200
        headers = {"content-type": "application/json"}
        content = b"{}"

        def json(self):
            return {"url": "https://eneo.example.test/f", "expires_at": int(time.time()) + 900}

    async def request(self, **kwargs):
        return self.Answer()

    post = get = send = request

    def build_request(self, method, url, headers=None, extensions=None):
        import httpx

        return httpx.Request(method, url, headers=headers, extensions=extensions)


def frontend_paths() -> set[str]:
    """Every /api path frontend/lib/api.ts builds (a template's placeholders become ids), without its query."""
    source = (REPOSITORY / "frontend" / "lib" / "api.ts").read_text()
    paths = set()
    for literal in re.findall(r"[`\"'](/api/[^`\"']*)[`\"']", source):
        path = re.sub(r"\$\{[^}]*\}", "x", literal).split("?")[0]
        if path not in {"/api/", "/api/auth/", "/api/eneo/"}:  # prefixes the page tests for, not paths it requests
            paths.add(path)
    return paths


def fill(template: str) -> str:
    """A template path of a route with ids in its parameters (a proxied path is any rest)."""
    return PARAMETER.sub(lambda match: UUID if match[1] in ("flow_id", "step_id") else "x", template).replace("x/x", "x")


def twin(path: str) -> str:
    return path[:-1] if path.endswith("/") else path + "/"


class SlashCase(unittest.TestCase):
    def setUp(self) -> None:
        main.module_auth.sessions.clear()
        self.addCleanup(setattr, main, "http_client", main.http_client)
        main.http_client = Eneo()
        self.anonymous = TestClient(main.app, raise_server_exceptions=False, follow_redirects=False)
        self.client = TestClient(main.app, raise_server_exceptions=False, follow_redirects=False)
        self.client.cookies.set(
            SESSION_COOKIE,
            main.module_auth.sessions.create(
                EneoSsoSession(
                    access_token="module-user-token",
                    expires_at=int(time.time()) + 600,
                    refresh_at=int(time.time()) + 300,
                    session_expires_at=int(time.time()) + 3600,
                    module_key="speech-to-text",
                    tenant_id="tenant-id",
                    user=ModuleUser(id="user-id", email="user@example.test"),
                )
            ),
        )
        self.client.headers["X-Expected-User"] = "user-id"
        self.client.headers["Origin"] = main.settings.module_origin


class NoRedirectTests(SlashCase):
    def test_no_route_of_the_app_answers_a_redirect_for_its_path_or_its_slash_twin(self) -> None:
        checked = 0
        for route in main.app.routes:
            if isinstance(route, APIWebSocketRoute) or not isinstance(route, APIRoute):
                continue
            for method in sorted(route.methods - {"OPTIONS"}):
                for path in (fill(route.path), twin(fill(route.path))):
                    for client in (self.anonymous, self.client):
                        with self.subTest(method=method, path=path, signed_in=client is self.client):
                            response = client.request(method, path)

                            self.assertNotIn(response.status_code, REDIRECTS, response.headers.get("location"))
                            checked += 1
        paths = {route.path for route in main.app.routes if isinstance(route, APIRoute)}
        for expected in ("/health", "/api/config", "/api/eneo/flows/{flow_id}/files/", "/api/eneo/{path:path}"):
            self.assertIn(expected, paths)
        self.assertGreater(checked, 2 * len(paths))

    def test_the_live_socket_and_its_twin_are_never_redirected(self) -> None:
        for path in (f"/api/live/{UUID}/{UUID}", f"/api/live/{UUID}/{UUID}/"):
            with self.subTest(path=path):
                response = self.anonymous.get(path)  # a plain GET of a WebSocket route: refused, not redirected

                self.assertNotIn(response.status_code, REDIRECTS)

    def test_every_allowlisted_path_and_its_slash_twin_is_never_redirected(self) -> None:
        for methods, pattern in main._PROXY_ROUTE_RULES:
            path = "/api/eneo/" + re.sub(r"\[\^/\]\+", "x", pattern.pattern).replace("(?:published|run-contract|graph)", "published").replace(
                "(?:status/)?", "").replace("(?:cancel|redispatch|retry)", "cancel").replace("(?:approve|reject|resume)", "approve").replace(
                "(?:export)?", "").replace("$", "")
            for method in sorted(methods):
                for candidate in (path, twin(path)):
                    with self.subTest(method=method, path=candidate):
                        response = self.client.request(method, candidate)

                        self.assertNotIn(response.status_code, REDIRECTS)

    def test_a_twin_that_is_not_a_route_is_a_json_404(self) -> None:
        for path in ("/api/config/", "/api/branding/", "/api/auth/status/", "/api/auth/login/", "/api/healthz/", "/health/"):
            with self.subTest(path=path):
                response = self.anonymous.get(path)

                self.assertEqual(response.status_code, 404)
                self.assertTrue(response.headers["content-type"].startswith("application/json"))


class FrontendPathTests(SlashCase):
    """The path the frontend builds reaches its handler exactly as written: refused by the session check or the
    allowlist when it is not signed in, never a 404 from a route that is not there and never a redirect."""

    def test_the_frontend_builds_the_paths_this_test_reads(self) -> None:
        paths = frontend_paths()

        self.assertIn("/api/config", paths)
        self.assertIn("/api/eneo/flows/x/runs/x/artifacts/x/content", paths)
        self.assertIn("/api/eneo/flows/x/runs/", paths)
        self.assertGreater(len(paths), 30)

    def test_each_one_reaches_its_handler_as_written(self) -> None:
        for path in sorted(frontend_paths()):
            with self.subTest(path=path):
                if path.startswith("/api/eneo/"):
                    unsigned = self.anonymous.get(path)
                    self.assertEqual(unsigned.status_code, 401, "the session check of the route is the first thing it meets")
                    self.assertNotIn(unsigned.status_code, REDIRECTS)
                    dedicated = any(
                        isinstance(route, APIRoute) and route.path != "/api/eneo/{path:path}" and route.path_regex.fullmatch(path)
                        for route in main.app.routes
                    )
                    listed = any(pattern.fullmatch(path.removeprefix("/api/eneo/")) for _, pattern in main._PROXY_ROUTE_RULES)
                    self.assertTrue(dedicated or listed, "neither a route of its own nor on the allowlist, as spelled")
                else:
                    response = self.anonymous.get(path)
                    self.assertNotEqual(response.status_code, 404, "no route for it")
                    self.assertNotIn(response.status_code, REDIRECTS)

    def test_the_slashless_form_of_an_allowlisted_path_is_refused_not_forwarded(self) -> None:
        for path in ("/api/eneo/flows", "/api/eneo/flows/x/published", "/api/eneo/flows/x/runs", "/api/eneo/flows/x/runs/y/status"):
            with self.subTest(path=path):
                response = self.client.get(path)

                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json(), {"detail": "Eneo resource is not exposed"})

    def test_a_path_with_the_slash_the_allowlist_spells_is_not_refused(self) -> None:
        self.assertTrue(main._proxy_route_is_allowed("GET", "flows/"))
        self.assertFalse(main._proxy_route_is_allowed("GET", "flows"))
        self.assertFalse(hasattr(main, "_resolve_proxy_path"))


if __name__ == "__main__":
    unittest.main()
