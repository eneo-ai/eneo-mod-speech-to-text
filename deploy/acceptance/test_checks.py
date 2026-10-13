"""What checks.py does with a failure the owner has accepted (waivers.json), and with every other one; and what check 17 passes
and refuses, given what an image's labels and its /health say.

    python -m unittest deploy/acceptance/test_checks.py      (from the repository root; standard library only)

The checks are replaced by small functions; nothing here touches docker.
"""

import contextlib
import io
import json
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from collections.abc import Callable
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import checks  # noqa: E402

WAIVER = {"code": "stress-over-twice-idle", "decision": "owner, 2026-10-04", "reason": "the relay is unaffected up to 45 visits/s", "measured": "p95 4.8 to 6.5 times idle"}


def passes() -> str:
    return "fine"


def fails(code: str | None = None) -> Callable[[], str]:
    def check() -> str:
        raise checks.Failed("the number was over", code=code)

    return check


def broken() -> str:
    raise RuntimeError("the check itself broke")


def run(fake: dict[int, Callable[[], str]], waivers: dict[int, dict[str, str]]) -> tuple[int, str]:
    """checks.main() over the fake checks: its exit code and what it printed."""
    out = io.StringIO()
    with (
        patch.object(checks, "CHECKS", {number: (f"check {number}", function) for number, function in fake.items()}),
        patch.object(checks, "ORDER", list(fake)),
        patch.object(checks, "WAIVERS", waivers),
        patch.object(checks, "docker", lambda *args, **kw: types.SimpleNamespace(stdout="")),
        patch.object(sys, "argv", ["checks.py"]),
        contextlib.redirect_stdout(out),
    ):
        code = checks.main()
    return code, out.getvalue()


class WaiverTests(unittest.TestCase):
    def test_a_failure_with_no_waiver_still_exits_1(self) -> None:
        code, out = run({1: passes, 7: fails("anything")}, {})

        self.assertEqual(code, 1)
        self.assertIn("FAIL  7  check 7", out)
        self.assertNotIn("waived", out)

    def test_a_waived_failure_is_printed_as_a_failure_with_its_reason_and_exits_0(self) -> None:
        code, out = run({1: passes, 15: fails(WAIVER["code"])}, {15: WAIVER})

        self.assertEqual(code, 0)
        self.assertIn("FAIL (waived: the relay is unaffected up to 45 visits/s) 15  check 15", out)
        self.assertIn("the number was over", out)
        self.assertIn("owner, 2026-10-04", out)
        self.assertIn("1 of 2 checks passed", out)

    def test_a_waiver_covers_its_own_check_only(self) -> None:
        code, out = run({7: fails(WAIVER["code"]), 15: fails(WAIVER["code"])}, {15: WAIVER})

        self.assertEqual(code, 1)
        self.assertIn("FAIL  7  check 7", out)
        self.assertIn("FAIL (waived", out)

    def test_a_waiver_covers_the_finding_it_names_and_not_another_failure_of_the_same_check(self) -> None:
        for other in (None, "relay-error"):
            with self.subTest(code=other):
                code, out = run({15: fails(other)}, {15: WAIVER})

                self.assertEqual(code, 1)
                self.assertNotIn("waived", out)

    def test_a_check_that_breaks_is_never_waived(self) -> None:
        code, out = run({15: broken}, {15: WAIVER})

        self.assertEqual(code, 1)
        self.assertIn("the check itself broke", out)


class EnvelopeTests(unittest.TestCase):
    def test_a_fraction_of_what_the_module_serves_of_the_visit_is_a_rate_of_visits_whatever_the_machine(self) -> None:
        # 100 visits/s served: a third is 35 visits/s. A machine that serves 60 gets the same share of its own, not the laptop's visits a second.
        self.assertEqual(checks.envelope_rate(0.35, 100), 35.0)
        self.assertEqual(checks.envelope_rate(0.35, 60.4), 21.1)
        self.assertEqual(checks.envelope_rate(0.8, 60.4), 48.3)


COMMIT, OTHER_COMMIT = "0123456789abcdef0123456789abcdef01234567", "89abcdef0123456789abcdef0123456789abcdef"
BUILT = "2026-10-13T08:15:00Z"
SAYS_NOTHING = (None, None)


def health(revision: str | None, build_date: str | None) -> dict[str, object]:
    return {"ok": True, "revision": revision, "build_date": build_date, "release": None}


class BuildIdentityCheckTests(unittest.TestCase):
    """Check 17, given what the two images' labels say and what their /health answers: what it passes and what it refuses."""

    def check(self, image: tuple, review: tuple = (SAYS_NOTHING, health(*SAYS_NOTHING)), *, told: str | None = None) -> str:
        """Run it where the image under test and the review build each are (what the labels say, what /health answers) and
        ``told`` is the commit the acceptance was told the image is built from (ACCEPT_REVISION)."""
        labels = {checks.STACK.image: image[0], checks.STACK.review_image: review[0]}
        with (
            patch.object(checks, "labelled", labels.__getitem__),
            patch.object(checks, "get", lambda url, **kw: types.SimpleNamespace(status=200, json=lambda: image[1])),
            patch.object(checks, "health_inside", lambda _: review[1]),
            patch.object(checks.STACK, "revision", told),
        ):
            return checks.check_17()

    def test_an_image_ci_built_answers_the_commit_and_the_date_of_its_labels(self) -> None:
        detail = self.check(((COMMIT, BUILT), health(COMMIT, BUILT)), told=COMMIT)

        self.assertIn(COMMIT, detail)
        self.assertIn(BUILT, detail)

    def test_a_local_build_says_nothing_in_its_labels_and_answers_null(self) -> None:
        self.assertIn("null", self.check((SAYS_NOTHING, health(*SAYS_NOTHING))))

    def test_an_answer_that_is_not_what_the_labels_say_is_refused(self) -> None:
        for name, answered in (
            ("another commit", health(OTHER_COMMIT, BUILT)),
            ("another date", health(COMMIT, "2026-10-13T08:15:01Z")),
            ("no commit: the record was not read", health(None, None)),
            ("no date", health(COMMIT, None)),
            ("no such fields", {"ok": True}),
        ):
            with self.subTest(name), self.assertRaisesRegex(checks.Failed, "/health"):
                self.check(((COMMIT, BUILT), answered))
        with self.assertRaisesRegex(checks.Failed, "/health"):
            self.check((SAYS_NOTHING, health(COMMIT, BUILT)))  # an answer the labels do not carry

    def test_an_image_that_is_not_of_the_commit_the_acceptance_was_told_is_refused(self) -> None:
        for name, says in (("another commit", (OTHER_COMMIT, BUILT)), ("no commit: the arguments did not reach the build", SAYS_NOTHING), ("no date", (COMMIT, None))):
            with self.subTest(name), self.assertRaisesRegex(checks.Failed, "ACCEPT_REVISION"):
                self.check((says, health(*says)), told=COMMIT)

    def test_a_build_without_arguments_that_says_a_commit_is_refused(self) -> None:
        image = ((COMMIT, BUILT), health(COMMIT, BUILT))
        for name, review in (
            ("in both places", ((COMMIT, BUILT), health(COMMIT, BUILT))),
            ("a date alone", ((None, BUILT), health(None, BUILT))),
            ("in its answer only", (SAYS_NOTHING, health(COMMIT, BUILT))),
            ("in its labels only", ((COMMIT, BUILT), health(*SAYS_NOTHING))),
        ):
            with self.subTest(name), self.assertRaises(checks.Failed):
                self.check(image, review, told=COMMIT)

    def test_a_label_that_is_empty_or_not_there_says_nothing(self) -> None:
        for labels, expected in (
            ("null", SAYS_NOTHING),  # an image with no labels at all
            ({"org.opencontainers.image.source": "https://example.test/repo"}, SAYS_NOTHING),
            ({"org.opencontainers.image.revision": "", "org.opencontainers.image.created": ""}, SAYS_NOTHING),  # a build without the arguments
            ({"org.opencontainers.image.revision": COMMIT, "org.opencontainers.image.created": BUILT}, (COMMIT, BUILT)),
        ):
            printed = labels if isinstance(labels, str) else json.dumps(labels)
            with self.subTest(labels=labels), patch.object(checks, "docker", lambda *args, **kw: types.SimpleNamespace(stdout=printed + "\n")):
                self.assertEqual(checks.labelled("an-image"), expected)

    def test_the_check_runs_before_the_two_that_stop_the_image(self) -> None:
        self.assertIn(17, checks.CHECKS)
        self.assertLess(checks.ORDER.index(17), checks.ORDER.index(10))
        self.assertEqual(sorted(checks.ORDER), sorted(checks.CHECKS))


class WaiverFileTests(unittest.TestCase):
    def read(self, entries: object) -> dict[int, dict[str, str]]:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "waivers.json"
            path.write_text(json.dumps(entries))
            return checks.read_waivers(path, {1, 15})

    def test_an_entry_with_all_its_fields_for_a_check_that_exists_is_read(self) -> None:
        self.assertEqual(self.read({"15": WAIVER}), {15: WAIVER})

    def test_an_entry_missing_a_field_or_with_an_empty_one_is_refused(self) -> None:
        for field in WAIVER:
            for value in (None, " "):
                with self.subTest(field=field, value=value):
                    entry = {**WAIVER, field: value}
                    if value is None:
                        del entry[field]
                    with self.assertRaisesRegex(ValueError, field):
                        self.read({"15": entry})

    def test_an_entry_for_a_check_that_does_not_exist_is_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, "99"):
            self.read({"99": WAIVER})

    def test_the_committed_waivers_are_valid(self) -> None:
        self.assertEqual(checks.read_waivers(checks.HERE / "waivers.json", checks.CHECKS), checks.WAIVERS)
        self.assertEqual(set(checks.WAIVERS), {15})


class StandsOnItsOwnTests(unittest.TestCase):
    def test_nothing_the_acceptance_runs_or_reads_lives_in_the_plans_or_the_board(self) -> None:
        # docs/plans/ and .beads/ are removed when the work they track is done; a check that ran a script from there would break with them.
        folder = Path(__file__).resolve().parent
        sources = [path for path in (*folder.rglob("*"), folder.parent / "acceptance.sh") if path.is_file() and path.suffix in {".py", ".cjs", ".sh", ".yml", ".json", ".env"}]
        named = [f"{path.relative_to(folder.parent)}:{number}" for path in sources if path != Path(__file__) for number, line in enumerate(path.read_text().splitlines(), 1) if "docs/plans" in line or ".beads" in line]

        self.assertEqual(named, [])


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class MeasuringScriptsNeedTheirArgumentsTests(unittest.TestCase):
    """A measurement script without what it measures stops with its usage text before it looks for a browser."""

    def run_script(self, script: str, *arguments: str) -> subprocess.CompletedProcess:
        # The first argument is a directory with no Playwright in it: a script that got as far as loading it would fail with another message.
        return subprocess.run(
            ["node", str(Path(__file__).resolve().parent / script), "/nonexistent", "http://localhost", *arguments],
            capture_output=True,
            text=True,
        )

    def assert_usage(self, result: subprocess.CompletedProcess) -> None:
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr, r"^usage: node ", "no usage text")
        self.assertEqual(result.stdout, "")

    def test_poll_needs_its_run_and_its_flow(self) -> None:
        for arguments in (("10", "60"), ("10", "60", "run-id"), ("10", "60", "", "flow-id")):
            with self.subTest(arguments=arguments):
                self.assert_usage(self.run_script("poll.cjs", *arguments))

    def test_poll_needs_a_number_of_browsers_and_seconds(self) -> None:
        for arguments in (("0", "60", "run-id", "flow-id"), ("ten", "60", "run-id", "flow-id"), ("10", "-1", "run-id", "flow-id"), ("1.5", "60", "run-id", "flow-id")):
            with self.subTest(arguments=arguments):
                self.assert_usage(self.run_script("poll.cjs", *arguments))

    def test_page_cost_needs_a_label_and_a_path(self) -> None:
        for arguments in ((), ("label",)):
            with self.subTest(arguments=arguments):
                self.assert_usage(self.run_script("page-cost.cjs", *arguments))


if __name__ == "__main__":
    unittest.main()
