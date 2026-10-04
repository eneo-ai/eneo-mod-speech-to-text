"""The backend's dependencies: requirements.txt names the direct ones, requirements.lock is every package with its hashes, and the
image and the tests use the lock, so the set that is tested is the set that ships."""

import re
import unittest
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]


def normalised(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def pins(text: str) -> dict[str, str]:
    """``name==version`` lines (extras and environment markers dropped), by normalised name."""
    found = re.findall(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?==([^\s;\\]+)", text, re.M)
    return {normalised(name): version for name, version in found}


class DependencyLockTests(unittest.TestCase):
    def test_every_direct_pin_is_in_the_lock_at_the_same_version(self) -> None:
        direct = pins((REPOSITORY / "backend" / "requirements.txt").read_text())
        locked = pins((REPOSITORY / "backend" / "requirements.lock").read_text())

        self.assertTrue(direct)
        for name, version in direct.items():
            with self.subTest(name=name):
                self.assertEqual(locked.get(name), version, "regenerate backend/requirements.lock (docs/operations.md)")

    def test_every_locked_package_has_a_hash(self) -> None:
        lock = (REPOSITORY / "backend" / "requirements.lock").read_text()
        blocks = re.split(r"(?m)^(?=[A-Za-z0-9][A-Za-z0-9._-]*==)", lock)[1:]

        self.assertGreater(len(blocks), 10)
        for block in blocks:
            with self.subTest(package=block.split("==")[0]):
                self.assertRegex(block, r"--hash=sha256:[0-9a-f]{64}")

    def test_the_image_installs_the_lock_with_its_hashes(self) -> None:
        dockerfile = (REPOSITORY / "Dockerfile").read_text()

        self.assertRegex(dockerfile, r"pip install [^\n]*--require-hashes[^\n]*--no-deps[^\n]*-r requirements\.lock")
        self.assertNotIn("requirements.txt", dockerfile)


if __name__ == "__main__":
    unittest.main()
