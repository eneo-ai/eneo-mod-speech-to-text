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
from app.accent import NO_ACCENT_CSS, Accent, etag, theme_css  # noqa: E402
from app.config import DEFAULT_ORGANIZATION, LogoFile, Organization  # noqa: E402

SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 4"></svg>'
PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c6360000200000500017a5eab3f0000000049454e44ae426082")  # a real 1x1 PNG


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
            self.assertEqual(response.headers["cache-control"], "no-cache")
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


GREEN = Accent(light="#1E7B34", dark="#2AAE4A", on_light="#FFFFFF", on_dark="#0B1118")


class BrandingThemeTests(unittest.TestCase):
    """The accent override the page links in its head: no session, no user data, safe to cache."""

    def setUp(self) -> None:
        self.client = TestClient(main.app)
        self.addCleanup(setattr, main.settings, "accent", main.settings.accent)

    def test_without_an_accent_it_is_a_valid_empty_cacheable_stylesheet(self) -> None:
        main.settings.accent = None
        response = self.client.get("/api/branding/theme.css")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.text, NO_ACCENT_CSS)
        self.assertTrue(response.headers["content-type"].startswith("text/css"))
        self.assertEqual(response.headers["cache-control"], "public, max-age=300")

    def test_the_accent_is_served_as_the_stylesheet_of_the_validated_colours(self) -> None:
        main.settings.accent = GREEN
        response = self.client.get("/api/branding/theme.css")
        self.assertEqual(response.text, theme_css(GREEN))
        self.assertIn("--color-accent: light-dark(#1E7B34, #2AAE4A);", response.text)

    def test_it_is_served_safely_and_without_user_data(self) -> None:
        main.settings.accent = GREEN
        response = self.client.get("/api/branding/theme.css", headers={"Cookie": "module_session=secret"})
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(response.headers["cache-control"], "public, max-age=300")
        self.assertNotIn("set-cookie", response.headers)
        self.assertNotIn("vary", response.headers)
        self.assertNotIn("secret", response.text)

    def test_the_etag_lets_a_browser_revalidate_for_nothing(self) -> None:
        main.settings.accent = GREEN
        first = self.client.get("/api/branding/theme.css")
        self.assertEqual(first.headers["etag"], etag(theme_css(GREEN)))
        for header in (first.headers["etag"], "W/" + first.headers["etag"], '"other", ' + first.headers["etag"], "*"):
            again = self.client.get("/api/branding/theme.css", headers={"If-None-Match": header})
            self.assertEqual((again.status_code, again.content), (304, b""), header)
            self.assertEqual(again.headers["etag"], first.headers["etag"])
            self.assertEqual(again.headers["cache-control"], "public, max-age=300")
        stale = self.client.get("/api/branding/theme.css", headers={"If-None-Match": '"0000000000000000"'})
        self.assertEqual(stale.status_code, 200)

    def test_another_accent_is_another_etag(self) -> None:
        main.settings.accent = GREEN
        green = self.client.get("/api/branding/theme.css").headers["etag"]
        main.settings.accent = None
        self.assertNotEqual(self.client.get("/api/branding/theme.css").headers["etag"], green)


if __name__ == "__main__":
    unittest.main()
