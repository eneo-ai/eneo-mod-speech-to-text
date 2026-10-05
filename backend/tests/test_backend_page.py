"""docs/backend.md lists the routes of the app and the calls the proxy forwards, and lists what the app has.

Both tables are written by hand, one row for each route and each allowlist entry, so that the page reads without a tool.
These tests are what keeps them the app's: a row that is missing, one that is left over, a method or a spelling that
differs fails with the rows concerned.
"""

import os
import re
import unittest
from pathlib import Path

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "http://localhost:3002")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")

from fastapi.routing import APIWebSocketRoute  # noqa: E402

from app import main  # noqa: E402
from app_routes import http_routes  # noqa: E402

PAGE = (Path(__file__).resolve().parents[2] / "docs" / "backend.md").read_text()


def section(heading: str) -> str:
    """The text of a `## heading` section, up to the next one."""
    return re.search(rf"^## {re.escape(heading)}\n(.*?)(?=^## |\Z)", PAGE, re.S | re.M).group(1)


class BackendPageTests(unittest.TestCase):
    def test_the_route_table_lists_every_route_of_the_app_and_nothing_else(self) -> None:
        listed = set()
        for paths, methods in re.findall(r"^\| (`/[^|]+) \| ([A-Za-z, ]+) \|", section("Rutter"), re.M):
            for path in re.findall(r"`([^`]+)`", paths):
                listed |= {(method.strip().upper(), path) for method in methods.split(",")}
        routes = {(method, route.path_format) for route in http_routes() for method in route.methods}
        routes |= {("WEBSOCKET", route.path) for route in main.app.routes if isinstance(route, APIWebSocketRoute)}

        self.assertEqual(sorted(listed - routes), [], "in the table, not in the app")
        self.assertEqual(sorted(routes - listed), [], "in the app, not in the table")
        self.assertGreater(len(listed), 15)

    def test_the_allowlist_table_lists_every_entry_of_the_allowlist_and_nothing_else(self) -> None:
        listed = {
            (frozenset(method.strip() for method in methods.split(",")), path)
            for methods, path in re.findall(
                r"^\| ([A-Z, ]+) \| `(/api/eneo/[^`]+)` \|$", section("Tillåtelselistan för Eneo-anrop"), re.M
            )
        }

        rows = lambda entries: sorted(f"{', '.join(sorted(methods))} {path}" for methods, path in entries)  # noqa: E731

        self.assertEqual(rows(listed - set(main.PROXY_ROUTES)), [], "in the table, not in the app")
        self.assertEqual(rows(set(main.PROXY_ROUTES) - listed), [], "in the app, not in the table")
        self.assertEqual(len(listed), len(main.PROXY_ROUTES))


if __name__ == "__main__":
    unittest.main()
