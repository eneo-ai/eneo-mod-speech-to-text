"""The one way the backend is started: one worker, no access log, bounded WebSockets, a stop that does not wait.

Model: the module kit's packages/bff/tests/test_serve.py (copied with its launcher; see app/serve.py).
"""

import ast
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import limits, serve as launcher

BACKEND = Path(__file__).resolve().parents[1]
# What the launcher needs to read Settings, which is where STATIC_DIR is read (and nowhere else).
CONFIGURATION = {
    "ENEO_BACKEND_URL": "http://backend:8000",
    "ENEO_PUBLIC_URL": "https://eneo.example.test",
    "MODULE_PUBLIC_URL": "https://module.example.test",
    "MODULE_KEY": "speech-to-text",
    "ENEO_API_KEY": "test-key",
    "SESSION_SECRET": "x" * 48,
}
FIXED = {
    "host": "0.0.0.0",
    "port": 3001,
    "workers": 1,
    "access_log": False,
    "server_header": False,
    "ws": "websockets",
    "ws_max_size": 128 * 1024,
    "ws_max_queue": 16,
    "timeout_graceful_shutdown": 8,
    "reload": False,
}


def built_ui() -> tempfile.TemporaryDirectory:
    folder = tempfile.TemporaryDirectory()
    (Path(folder.name) / "index.html").write_text("<!doctype html>")
    return folder


class ServeTests(unittest.TestCase):
    def test_serve_runs_one_worker_without_an_access_log_or_a_server_banner_and_with_bounded_websockets(self) -> None:
        with patch("uvicorn.run") as run:
            launcher.serve("app.main:app", api_only=True)

        run.assert_called_once_with("app.main:app", **FIXED)

    def test_the_constants_are_the_ones_in_limits(self) -> None:
        self.assertEqual((limits.WS_MAX_MESSAGE_BYTES, limits.WS_MAX_QUEUE), (128 * 1024, 16))
        with patch("uvicorn.run") as run:
            launcher.serve("app.main:app", api_only=True)

        self.assertEqual(run.call_args.kwargs["ws_max_size"], limits.WS_MAX_MESSAGE_BYTES)
        self.assertEqual(run.call_args.kwargs["ws_max_queue"], limits.WS_MAX_QUEUE)

    def test_the_websocket_implementation_is_the_one_that_applies_the_queue_limit(self) -> None:
        # uvicorn's "auto" is websockets-sansio, which has no ws_max_queue: the limit would be set and do nothing.
        with patch("uvicorn.run") as run:
            launcher.serve("app.main:app", api_only=True)

        self.assertEqual(run.call_args.kwargs["ws"], "websockets")

    def test_the_limits_satisfy_the_bounds_the_relay_depends_on(self) -> None:
        # Eneo's largest audio frame (64 KiB) fits, and a connection queues at most 2 MiB before Eneo sees a frame.
        self.assertGreaterEqual(limits.WS_MAX_MESSAGE_BYTES, 64 * 1024)
        self.assertLessEqual(limits.WS_MAX_MESSAGE_BYTES * limits.WS_MAX_QUEUE, 2 * 2**20)

    def test_host_and_port_can_be_chosen_and_so_can_options_the_launcher_does_not_fix(self) -> None:
        with patch("uvicorn.run") as run:
            launcher.serve("app.main:app", host="127.0.0.1", port=8000, api_only=True, log_level="warning")

        run.assert_called_once_with("app.main:app", **{**FIXED, "host": "127.0.0.1", "port": 8000}, log_level="warning")

    def test_a_stop_gives_open_connections_less_time_than_dockers_ten_seconds(self) -> None:
        # Without it uvicorn waits for every open stream, and a file that is still streaming never ends by itself.
        with patch("uvicorn.run") as run:
            launcher.serve("app.main:app", api_only=True)

        self.assertLess(run.call_args.kwargs["timeout_graceful_shutdown"], 10)

    def test_what_the_launcher_fixes_cannot_be_overridden_and_nothing_starts(self) -> None:
        # Another value, and the very value it fixes: the launcher is the one place that says what they are.
        attempts = {
            "workers": (2, 1),
            "access_log": (True, False),
            "server_header": (True, False),
            "ws": ("wsproto", "websockets"),
            "ws_max_size": (1024**3, 128 * 1024),
            "ws_max_queue": (10_000, 16),
            "timeout_graceful_shutdown": (30, 8),
        }
        for name, values in attempts.items():
            for value in values:
                with self.subTest(name=name, value=value), patch("uvicorn.run") as run:
                    with self.assertRaises(ValueError):
                        launcher.serve("app.main:app", api_only=True, **{name: value})
                    run.assert_not_called()

    def test_reload_runs_the_app_as_its_import_string(self) -> None:
        with patch("uvicorn.run") as run:
            launcher.serve("app.main:app", api_only=True, reload=True)

        run.assert_called_once_with("app.main:app", **{**FIXED, "reload": True})

    def test_reload_needs_the_import_string(self) -> None:
        with patch("uvicorn.run") as run:
            with self.assertRaises(ValueError):
                launcher.serve(object(), api_only=True, reload=True)  # type: ignore[arg-type]
            run.assert_not_called()


class BuiltUiTests(unittest.TestCase):
    """Without --api-only the launcher serves the UI, and refuses to start where there is none to serve."""

    def refused(self, **environment: str) -> str:
        with patch.dict(os.environ, {**CONFIGURATION, **environment}, clear=True), patch("uvicorn.run") as run:
            with self.assertRaises(SystemExit) as refused:
                launcher.serve("app.main:app")
            run.assert_not_called()
        self.assertNotEqual(refused.exception.code, 0)
        return str(refused.exception.code)

    def test_a_missing_folder_is_refused_with_its_name(self) -> None:
        message = self.refused(STATIC_DIR="/nowhere/dist")

        self.assertIn("/nowhere/dist", message)
        self.assertIn("index.html", message)

    def test_a_folder_without_index_html_is_refused_with_its_name(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            message = self.refused(STATIC_DIR=folder)

        self.assertIn(folder, message)

    def test_no_folder_at_all_is_refused_and_the_message_names_the_setting(self) -> None:
        for environment in ({}, {"STATIC_DIR": ""}):
            with self.subTest(environment=environment):
                message = self.refused(**environment)

                self.assertIn("STATIC_DIR", message)
                self.assertIn("--api-only", message)

    def test_a_built_ui_starts(self) -> None:
        with built_ui() as folder, patch.dict(os.environ, {**CONFIGURATION, "STATIC_DIR": folder}, clear=True), patch("uvicorn.run") as run:
            launcher.serve("app.main:app")

        run.assert_called_once_with("app.main:app", **FIXED)

    def test_api_only_starts_with_no_ui_and_reads_no_settings(self) -> None:
        with patch.dict(os.environ, {}, clear=True), patch("uvicorn.run") as run:
            launcher.serve("app.main:app", api_only=True)

        run.assert_called_once_with("app.main:app", **FIXED)

    def test_the_command_line_refuses_too_and_exits_non_zero_naming_the_folder(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            done = subprocess.run(
                [sys.executable, "-m", "app.serve", "--port", "1"],
                cwd=BACKEND, env={**os.environ, **CONFIGURATION, "STATIC_DIR": folder}, capture_output=True, text=True, timeout=60,
            )

        self.assertNotEqual(done.returncode, 0)
        self.assertIn(folder, done.stderr)

    def test_settings_is_the_only_reader_of_static_dir(self) -> None:
        # The launcher and the app must agree on the folder: one reader, so that they cannot disagree about it.
        readers = set()
        for source in sorted((BACKEND / "app").glob("*.py")):
            for node in ast.walk(ast.parse(source.read_text())):
                call_of_get = isinstance(node, ast.Call) and node.args and (
                    (isinstance(node.func, ast.Attribute) and node.func.attr in {"get", "getenv", "pop"})
                )
                subscript = isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant)
                constant = node.args[0] if call_of_get else node.slice if subscript else None
                if isinstance(constant, ast.Constant) and constant.value == "STATIC_DIR":
                    readers.add(source.name)

        self.assertEqual(readers, {"config.py"})


class CommandLineTests(unittest.TestCase):
    def test_the_defaults_are_the_app_on_all_interfaces_at_3001(self) -> None:
        with built_ui() as folder, patch.dict(os.environ, {**CONFIGURATION, "STATIC_DIR": folder}, clear=True), patch("uvicorn.run") as run:
            launcher.main([])

        run.assert_called_once_with("app.main:app", **FIXED)

    def test_the_options_are_host_port_reload_and_api_only(self) -> None:
        with patch.dict(os.environ, {}, clear=True), patch("uvicorn.run") as run:
            launcher.main(["--api-only", "--host", "127.0.0.1", "--port", "8000", "--reload"])

        run.assert_called_once_with("app.main:app", **{**FIXED, "host": "127.0.0.1", "port": 8000, "reload": True})

    def test_an_option_that_is_fixed_is_not_an_option(self) -> None:
        for flag in ("--workers", "--no-access-log", "--ws-max-size", "--ws-max-queue", "--server-header"):
            with self.subTest(flag), patch("uvicorn.run") as run, patch("sys.stderr"):
                with self.assertRaises(SystemExit) as refused:
                    launcher.main(["--api-only", flag, "2"])
                self.assertNotEqual(refused.exception.code, 0)
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
