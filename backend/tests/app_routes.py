"""The HTTP routes of the app, for the tests that go through all of them."""

from typing import NamedTuple

from fastapi.routing import APIRoute

from app import main


class Route(NamedTuple):
    path: str  # as declared: "/api/eneo/{path:path}"
    path_format: str  # without the converters: "/api/eneo/{path}", which is how OpenAPI spells it
    methods: set[str]


def http_routes() -> list[Route]:
    """Every HTTP route of the app. The auth router is included under /api/auth and the app lists it as one object, so
    its routes are the router's."""
    routes = [Route(r.path, r.path_format, r.methods) for r in main.app.routes if isinstance(r, APIRoute)]
    return routes + [
        Route(f"/api/auth{r.path}", f"/api/auth{r.path_format}", r.methods) for r in main.module_auth.router.routes
    ]
