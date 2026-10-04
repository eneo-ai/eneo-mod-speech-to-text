import os
import unittest

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


class LifespanTests(unittest.TestCase):
    def test_the_shared_client_is_closed_when_the_app_shuts_down(self) -> None:
        original = main.http_client
        main.http_client = httpx.AsyncClient()
        self.addCleanup(setattr, main, "http_client", original)

        with TestClient(main.app):
            self.assertFalse(main.http_client.is_closed)

        self.assertTrue(main.http_client.is_closed)


if __name__ == "__main__":
    unittest.main()
