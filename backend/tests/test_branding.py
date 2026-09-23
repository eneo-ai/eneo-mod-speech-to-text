import os
import unittest

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "https://module.example.test")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("AUTH_MODE", "eneo_sso")

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.config import DEFAULT_ORGANIZATION, LogoFile, Organization  # noqa: E402

SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 4"></svg>'
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


class BrandingRouteTests(unittest.TestCase):
    """The login page shows the organisation before there is a session, so neither route asks for one."""

    def setUp(self) -> None:
        self.client = TestClient(main.app)
        saved = (main.settings.organization, main.settings.organization_logo, main.settings.organization_logo_dark)
        self.addCleanup(self.restore, saved)

    def restore(self, saved) -> None:
        main.settings.organization, main.settings.organization_logo, main.settings.organization_logo_dark = saved

    def use(self, organization, logo=None, dark=None) -> None:
        main.settings.organization = organization
        main.settings.organization_logo = logo
        main.settings.organization_logo_dark = dark

    def test_the_branding_says_who_is_shown_without_a_session(self) -> None:
        self.use(DEFAULT_ORGANIZATION)
        self.assertEqual(
            self.client.get("/api/branding").json(),
            {"organization": {"name": "Sundsvalls kommun", "logo": "default", "dark_logo": False}},
        )
        self.use(None)
        self.assertEqual(self.client.get("/api/branding").json(), {"organization": None})

    def test_a_deployments_logo_is_served_same_origin_as_what_it_is(self) -> None:
        self.use(
            Organization(name="Umeå kommun", logo="custom", dark_logo=True),
            LogoFile(media_type="image/svg+xml", content=SVG),
            LogoFile(media_type="image/png", content=PNG),
        )

        light = self.client.get("/api/branding/logo/light")
        dark = self.client.get("/api/branding/logo/dark")

        self.assertEqual((light.status_code, light.content), (200, SVG))
        self.assertEqual(light.headers["content-type"], "image/svg+xml")
        self.assertEqual((dark.status_code, dark.content), (200, PNG))
        self.assertEqual(dark.headers["content-type"], "image/png")
        for response in (light, dark):
            self.assertEqual(response.headers["x-content-type-options"], "nosniff")
            self.assertEqual(response.headers["cache-control"], "public, max-age=3600")
            # An SVG opened on its own runs nothing in the module's origin.
            self.assertIn("sandbox", response.headers["content-security-policy"])

    def test_no_logo_file_is_not_found(self) -> None:
        self.use(Organization(name="Umeå kommun", logo=None))
        self.assertEqual(self.client.get("/api/branding/logo/light").status_code, 404)
        self.use(
            Organization(name="Umeå kommun", logo="custom"),
            LogoFile(media_type="image/svg+xml", content=SVG),
        )
        self.assertEqual(self.client.get("/api/branding/logo/dark").status_code, 404)
        self.assertEqual(self.client.get("/api/branding/logo/other").status_code, 422)


if __name__ == "__main__":
    unittest.main()
