"""The release path: ci.yml tests an image, publish.yml pushes it as the commit's, release.yml gives that image its version, and
docker-compose.yml pulls it. They have to name the same image and never build one a second time."""

import re
import unittest
from pathlib import Path

import yaml

REPOSITORY = Path(__file__).resolve().parents[2]
WORKFLOWS = REPOSITORY / ".github" / "workflows"
IMAGE = "ghcr.io/eneo-ai/eneo-mod-speech-to-text"


def workflow(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text())


def triggers(parsed: dict) -> dict:
    return parsed.get("on", parsed.get(True))  # YAML reads a bare `on` as the boolean True


class ReleasePathTests(unittest.TestCase):
    def test_compose_publish_and_release_name_the_same_image(self) -> None:
        compose = yaml.safe_load((REPOSITORY / "docker-compose.yml").read_text())["services"]["speech-to-text"]["image"]
        metadata = next(step for step in workflow("publish.yml")["jobs"]["ghcr"]["steps"] if step.get("id") == "meta")

        self.assertEqual(compose.split(":${")[0], IMAGE)
        self.assertEqual(metadata["with"]["images"], IMAGE)
        self.assertEqual(workflow("release.yml")["env"]["IMAGE"], IMAGE)

    def test_main_publishes_the_commit_and_only_a_release_gives_a_version_and_latest(self) -> None:
        metadata = next(step for step in workflow("publish.yml")["jobs"]["ghcr"]["steps"] if step.get("id") == "meta")

        self.assertEqual(metadata["with"]["tags"].split(), ["type=sha,format=long"])
        self.assertNotIn("tags", triggers(workflow("ci.yml"))["push"])  # a tag runs no CI: the release promotes
        release = triggers(workflow("release.yml"))["push"]
        self.assertEqual(release, {"tags": ["v[0-9]+.[0-9]+.[0-9]+"]})

    def test_a_release_promotes_the_image_of_the_commit_and_builds_nothing(self) -> None:
        text = (WORKFLOWS / "release.yml").read_text()

        self.assertIn('source="$IMAGE:sha-$commit"', text)
        self.assertIn('commit="$(git rev-parse HEAD)"', text)
        self.assertIn("--preserve-digests", text)
        self.assertIn('test "sha256:$pushed" = "$digest"', text)
        for building in ("docker build", "buildx", "build-push-action"):
            with self.subTest(building=building):
                self.assertNotIn(building, text)
        self.assertEqual(workflow("release.yml")["permissions"], {"contents": "read"})

    def test_every_action_is_a_commit_and_one_skopeo_digest_is_used_everywhere(self) -> None:
        for name in ("ci.yml", "publish.yml", "release.yml"):
            for use in re.findall(r"(?m)^\s*(?:-\s+)?uses:\s*(\S+)", (WORKFLOWS / name).read_text()):
                with self.subTest(workflow=name, uses=use):
                    self.assertTrue(use.startswith("./") or re.fullmatch(r"[\w./-]+@[0-9a-f]{40}", use), f"{use} is not pinned to a commit")
        skopeo = {
            name: re.search(r"(?m)^\s*SKOPEO:\s*(quay\.io/skopeo/stable@sha256:[0-9a-f]{64})$", (WORKFLOWS / name).read_text())
            for name in ("ci.yml", "publish.yml", "release.yml")
        }
        self.assertTrue(all(skopeo.values()), skopeo)
        self.assertEqual(len({match.group(1) for match in skopeo.values() if match}), 1)


if __name__ == "__main__":
    unittest.main()
