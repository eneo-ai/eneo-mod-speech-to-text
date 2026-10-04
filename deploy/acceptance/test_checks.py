"""What checks.py does with a failure the owner has accepted (waivers.json), and with every other one.

    python -m unittest deploy/acceptance/test_checks.py      (from the repository root; standard library only)

The checks are replaced by small functions; nothing here touches docker.
"""

import contextlib
import io
import json
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


if __name__ == "__main__":
    unittest.main()
