"""The release path: ci.yml tests an image, publish.yml pushes it as the commit's, release.yml gives that image its version, and
docker-compose.yml pulls it. They have to name the same image and never build one a second time, and the image says which
commit it was built from all the way: the build is given the commit, and the release checks it."""

import re
import unittest
from pathlib import Path

import yaml
from app import config

REPOSITORY = Path(__file__).resolve().parents[2]
WORKFLOWS = REPOSITORY / ".github" / "workflows"
IMAGE = "ghcr.io/eneo-ai/eneo-mod-speech-to-text"
SOURCE = "https://github.com/eneo-ai/eneo-mod-speech-to-text"


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
        # What the backend answers as a release is a tag this workflow takes, and nothing else (app/config.py).
        self.assertEqual(config.VERSION_TAG.pattern.replace("\\.", "."), release["tags"][0])

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

    def test_a_release_is_refused_unless_its_image_says_it_was_built_from_the_tagged_commit(self) -> None:
        text = (WORKFLOWS / "release.yml").read_text()
        given, read = text.index('for tag in "$GITHUB_REF_NAME" latest; do'), text.index('revision="$(')

        # The tagged commit, the tested image of that commit, the commit baked into it; the same digest is then given the tags.
        self.assertIn("""--format '{{index .Labels "org.opencontainers.image.revision"}}' "docker://$source")""", text)
        self.assertIn('if [ "$revision" != "$commit" ]; then', text)
        # Before any tag moves: an image that says another commit gets no version, no `latest` and no GitHub Release.
        self.assertLess(read, given)
        self.assertLess(given, text.index("gh release create"))
        refusal = text[text.index('if [ "$revision" != "$commit" ]; then') :]
        self.assertLess(refusal.index("exit 1"), refusal.index("fi\n"))

    def test_ci_gives_the_build_the_commit_and_one_timestamp_and_the_image_says_them_twice(self) -> None:
        steps = workflow("ci.yml")["jobs"]["image"]["steps"]
        source, build = (next(step for step in steps if step.get("id") == name) for name in ("source", "build"))
        dockerfile = (REPOSITORY / "Dockerfile").read_text()

        # The commit that is checked out and the clock are read once, before the build, and the build is given both.
        self.assertLess(steps.index(source), steps.index(build))
        self.assertEqual(
            source["run"].splitlines(),
            ['echo "revision=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"', 'echo "built=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$GITHUB_OUTPUT"'],
        )
        given = dict(line.split("=", 1) for line in build["with"]["build-args"].splitlines())
        self.assertEqual(given, {"SOURCE_REVISION": "${{ steps.source.outputs.revision }}", "BUILD_DATE": "${{ steps.source.outputs.built }}"})
        # Under the names the Dockerfile declares (a build argument it does not declare is dropped without an error), each
        # empty unless given: a build without them invents nothing.
        for name in given:
            with self.subTest(argument=name):
                self.assertRegex(dockerfile, rf"(?m)^ARG {name}=$")
        # The labels and the build record the backend reads are written from the same two arguments.
        labels = re.search(r"(?m)^LABEL (?:.*\\\n)*.*$", dockerfile).group(0)
        for label, value in (("source", SOURCE), ("revision", "$SOURCE_REVISION"), ("created", "$BUILD_DATE")):
            with self.subTest(label=label):
                self.assertIn(f'org.opencontainers.image.{label}="{value}"', labels)
        record = next(line for line in dockerfile.splitlines() if config.BUILD_RECORD.name in line)
        self.assertTrue(record.startswith("RUN ") and record.endswith(' "$SOURCE_REVISION" "$BUILD_DATE"'), record)
        self.assertIn(f"backend/app/{config.BUILD_RECORD.name}", record)
        # The acceptance is told the commit, so an image that says another one, or none, does not pass (checks.py, check 17).
        accept = next(step for step in steps if step.get("name") == "Accept the image")
        self.assertEqual(accept["env"]["ACCEPT_REVISION"], "${{ steps.source.outputs.revision }}")

    def test_only_the_tested_image_is_given_a_commit(self) -> None:
        # The speaker-review image of the acceptance and a developer's build are built without the arguments, and say so with nulls.
        review = next(step for step in workflow("ci.yml")["jobs"]["image"]["steps"] if step.get("name") == "Build the speaker-review image")
        local = [line.strip() for line in (REPOSITORY / "deploy" / "acceptance.sh").read_text().splitlines() if line.strip().startswith("docker build")]
        override = yaml.safe_load((REPOSITORY / "docker-compose.override.yml").read_text())["services"]["speech-to-text"]["build"]

        self.assertEqual(len(local), 2)  # the image under test and the review build
        for build in (review["run"], *local):
            with self.subTest(build=build):
                self.assertNotIn("SOURCE_REVISION", build)
                self.assertNotIn("BUILD_DATE", build)
        self.assertEqual(list(override["args"]), ["SPEAKER_REVIEW_ENABLED"])

    def test_actions_are_pinned_and_skopeo_uses_one_retained_immutable_release(self) -> None:
        for name in ("ci.yml", "publish.yml", "release.yml"):
            for use in re.findall(r"(?m)^\s*(?:-\s+)?uses:\s*(\S+)", (WORKFLOWS / name).read_text()):
                with self.subTest(workflow=name, uses=use):
                    self.assertTrue(use.startswith("./") or re.fullmatch(r"[\w./-]+@[0-9a-f]{40}", use), f"{use} is not pinned to a commit")
        skopeo = {
            name: re.search(r"(?m)^\s*SKOPEO:\s*(quay\.io/containers/skopeo:v\d+\.\d+\.\d+-immutable@sha256:[0-9a-f]{64})$", (WORKFLOWS / name).read_text())
            for name in ("ci.yml", "publish.yml", "release.yml")
        }
        self.assertTrue(all(skopeo.values()), skopeo)
        self.assertEqual(len({match.group(1) for match in skopeo.values() if match}), 1)


if __name__ == "__main__":
    unittest.main()
