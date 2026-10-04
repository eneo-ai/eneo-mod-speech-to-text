"""The stub is also Eneo: the real backend, started the way production starts it, in front of it.

    backend/.venv/bin/python -m unittest frontend/tests/e2e/test_stub_eneo.py     (from the repository root)

Two processes of this repository on two ports of 8470-8479: the stub (stub-server.py, the one fake Eneo of Plan B) and
`python -m app.serve --api-only` with the stub as ENEO_BACKEND_URL. Every test signs in on its own, through the real
module-login handshake, so no test shares a session. The same checks run in a browser as tests/prod/upstream.spec.ts.
"""

import asyncio
import http.client
import json
import os
import socket
import struct
import subprocess
import sys
import time
import unittest
from pathlib import Path
from urllib.parse import quote

import websockets.asyncio.client as websocket_client
from websockets.exceptions import ConnectionClosed

REPOSITORY = Path(__file__).resolve().parents[3]
BACKEND = REPOSITORY / "backend"
STUB = Path(__file__).with_name("stub-server.py")
IDS = json.loads((REPOSITORY / "frontend" / "tests" / "fixtures" / "ids.json").read_text())
FLOW, AUDIO_STEP, DONE = IDS["flows"]["flow1"], IDS["steps"]["audio"], IDS["runs"]["done"]
AUDIO_FILE, PDF_FILE, AUDIO_LARGE = IDS["files"]["audioA"], IDS["files"]["pdf"], IDS["files"]["audioLarge"]
MODULE_KEY, SERVICE_KEY = "speech-to-text", "stub-test-service-key"
USER = "user-1"
KB = 1024


def free_ports(count: int) -> list[int]:
    ports = []
    for port in range(8470, 8480):
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)  # as the servers do: a port in TIME_WAIT is free
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
        ports.append(port)
        if len(ports) == count:
            return ports
    raise unittest.SkipTest("no free port in 8470-8479")


def call(port: int, method: str, path: str, *, headers: dict[str, str] | None = None, body: bytes | None = None):
    """One request, no redirect followed: (status, lower-cased headers, body, every Set-Cookie)."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    connection.request(method, path, body=body, headers=headers or {})
    response = connection.getresponse()
    data = response.read()
    answer = (response.status, {k.lower(): v for k, v in response.getheaders()}, data, response.msg.get_all("set-cookie") or [])
    connection.close()
    return answer


def multipart(size: int, filename: str = "inspelning.webm") -> tuple[dict[str, str], bytes]:
    boundary = "stubboundary"
    head = f'--{boundary}\r\nContent-Disposition: form-data; name="upload_file"; filename="{filename}"\r\nContent-Type: audio/webm\r\n\r\n'.encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    body = head + b"\x01" * size + tail
    return {"Content-Type": f"multipart/form-data; boundary={boundary}", "Content-Length": str(len(body))}, body


class Stack(unittest.TestCase):
    """A stub and a backend in front of it, started once for the class; each test signs in on its own."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.stub, cls.backend = free_ports(2)
        python = os.environ.get("BACKEND_PYTHON", sys.executable)
        environment = {**os.environ, "MODULE_KEY": MODULE_KEY, "ENEO_API_KEY": SERVICE_KEY}
        cls.stub_process = cls.start([python, str(STUB), str(cls.stub)], environment, cwd=None)
        cls.origin = f"http://127.0.0.1:{cls.backend}"
        backend_environment = {
            **environment,
            "ENEO_BACKEND_URL": f"http://127.0.0.1:{cls.stub}",
            "ENEO_PUBLIC_URL": f"http://127.0.0.1:{cls.stub}",
            "MODULE_PUBLIC_URL": cls.origin,
            "SESSION_SECRET": "s" * 48,
            "COOKIE_SECURE": "false",
        }
        cls.start([python, "-m", "app.serve", "--api-only", "--host", "127.0.0.1", "--port", str(cls.backend)], backend_environment, cwd=BACKEND)
        cls.wait_for(cls.stub, "/api/auth/status")
        cls.wait_for(cls.backend, "/health")

    @classmethod
    def start(cls, command: list[str], environment: dict[str, str], cwd: Path | None) -> subprocess.Popen:
        """A process of this test, stopped (by its PID, nothing else) when the class is done, even if its set-up fails."""
        process = subprocess.Popen(command, cwd=cwd, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        def stop() -> None:
            process.terminate()
            process.wait(timeout=15)

        cls.addClassCleanup(stop)
        return process

    @staticmethod
    def wait_for(port: int, path: str) -> None:
        for _ in range(100):
            try:
                if call(port, "GET", path)[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(0.1)
        raise RuntimeError(f"nothing answered on {port}{path}")

    def setUp(self) -> None:
        call(self.stub, "POST", "/__stub/reset")

    def stats(self) -> dict:
        return json.loads(call(self.stub, "GET", "/__stub/stats")[2])

    def eventually(self, condition, what: str):
        for _ in range(60):
            value = condition()
            if value:
                return value
            time.sleep(0.05)
        self.fail(what)


class SignedIn(Stack):
    """Every test has a session of its own, made by the real handshake."""

    def setUp(self) -> None:
        super().setUp()
        self.cookie = self.sign_in()

    def sign_in(self) -> str:
        """The module's SSO handshake as a browser makes it, each redirect followed by hand. Returns the session cookie."""
        status, headers, _, cookies = call(self.backend, "GET", f"/api/auth/login?next={quote('/flows')}")
        self.assertEqual(status, 303, headers)
        pending = "; ".join(cookie.split(";")[0] for cookie in cookies)
        self.assertTrue(headers["location"].startswith(f"http://127.0.0.1:{self.stub}/module-login?"), headers["location"])
        status, headers, _, _ = call(self.stub, "GET", headers["location"].removeprefix(f"http://127.0.0.1:{self.stub}"))
        self.assertEqual(status, 303, headers)
        self.assertTrue(headers["location"].startswith(f"{self.origin}/api/auth/callback?ticket="), headers["location"])
        status, headers, _, cookies = call(self.backend, "GET", headers["location"].removeprefix(self.origin), headers={"Cookie": pending})
        self.assertEqual((status, headers["location"]), (303, "/flows"))
        session = [cookie.split(";")[0] for cookie in cookies if cookie.startswith("eneo_module_session=")]
        self.assertTrue(session, cookies)
        return session[0]

    def api(self, method: str, path: str, *, user: str | None = USER, headers: dict[str, str] | None = None, body: bytes | None = None):
        """A request of the page: its cookie, its origin and (when it has one) the user it was opened for."""
        sent = {"Cookie": self.cookie, "Origin": self.origin, **(headers or {})}
        if user is not None:
            sent["X-Expected-User"] = user
        return call(self.backend, method, path, headers=sent, body=body)


class HandshakeTests(SignedIn):
    def test_a_sign_in_through_the_stub_gives_a_session_of_the_stubs_user(self) -> None:
        status, _, body, _ = self.api("GET", "/api/auth/status")

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["user"]["id"], USER)
        self.assertNotIn("auth_mode", json.loads(body), "there is one way to sign in")

    def test_two_sign_ins_are_two_sessions_and_ending_one_leaves_the_other(self) -> None:
        other = self.sign_in()
        self.assertNotEqual(other, self.cookie)

        self.api("POST", "/api/auth/logout")

        status, _, body, _ = call(self.backend, "GET", "/api/auth/status", headers={"Cookie": other})
        self.assertEqual((status, json.loads(body)["authenticated"]), (200, True))
        self.assertEqual(self.api("GET", "/api/eneo/flows/")[0], 401, "the session that logged out is gone")

    def test_the_stub_refuses_what_eneo_refuses(self) -> None:
        token = "/api/v1/module-auth/token/"
        self.assertEqual(call(self.stub, "POST", token, body=b'{"ticket": "x"}')[0], 401, "no service key")
        key = {"X-API-Key": SERVICE_KEY}
        self.assertEqual(call(self.stub, "POST", token, headers=key, body=b'{"ticket": "unknown"}')[0], 400)
        self.assertEqual(call(self.stub, "GET", "/module-login?module_key=other&redirect_uri=http://x/&state=s")[0], 400)
        self.assertEqual(call(self.stub, "GET", "/api/v1/flows/")[0], 401, "no service key")
        self.assertEqual(call(self.stub, "GET", "/api/v1/flows/", headers={**key, "Authorization": "Bearer not-a-token"})[0], 401)
        self.assertEqual(call(self.stub, "GET", "/api/v1/flows/", headers=key)[0], 200, "the service key alone is enough for Eneo, as it is for the real one")

    def test_a_ticket_is_good_once(self) -> None:
        status, headers, _, _ = call(self.stub, "GET", f"/module-login?module_key={MODULE_KEY}&redirect_uri=http://x/cb&state=s1")
        ticket = headers["location"].split("ticket=")[1].split("&")[0]
        self.assertEqual(headers["location"].split("state=")[1], "s1")
        body = json.dumps({"ticket": ticket}).encode()
        key = {"X-API-Key": SERVICE_KEY}

        first = call(self.stub, "POST", "/api/v1/module-auth/token/", headers=key, body=body)
        second = call(self.stub, "POST", "/api/v1/module-auth/token/", headers=key, body=body)

        self.assertEqual((status, first[0], second[0]), (303, 200, 400))
        self.assertEqual(json.loads(first[2])["user"]["id"], USER)

    def test_ending_the_session_at_eneo_ends_it_at_the_module_on_the_next_refresh(self) -> None:
        status, headers, _, _ = call(self.stub, "GET", f"/module-login?module_key={MODULE_KEY}&redirect_uri=http://x/cb&state=s")
        ticket = headers["location"].split("ticket=")[1].split("&")[0]
        key = {"X-API-Key": SERVICE_KEY}
        token = json.loads(call(self.stub, "POST", "/api/v1/module-auth/token/", headers=key, body=json.dumps({"ticket": ticket}).encode())[2])["access_token"]
        refresh = f"/api/v1/module-auth/{MODULE_KEY}/token/refresh/"
        both = {**key, "Authorization": f"Bearer {token}"}
        self.assertEqual(call(self.stub, "POST", refresh, headers=both)[0], 200)

        self.assertEqual(call(self.stub, "POST", "/__stub/end-session")[0], 200)

        self.assertEqual(call(self.stub, "POST", refresh, headers=both)[0], 401)
        self.assertEqual(call(self.stub, "GET", f"/api/v1/module-auth/{MODULE_KEY}/session/", headers=both)[0], 401)


class ProxyTests(SignedIn):
    def test_the_flow_list_comes_through_the_real_backend_with_the_stubs_uuids(self) -> None:
        status, _, body, _ = self.api("GET", "/api/eneo/flows/?published=true", user=None)

        self.assertEqual(status, 200)
        ids = {item["id"] for item in json.loads(body)["items"]}
        self.assertIn(FLOW, ids)
        self.assertTrue(ids <= set(IDS["flows"].values()))

    def test_a_flow_its_contract_a_run_and_its_steps_come_through(self) -> None:
        for path in (f"/api/eneo/flows/{FLOW}/published/", f"/api/eneo/flows/{FLOW}/run-contract/", f"/api/eneo/flows/{FLOW}/runs/{DONE}/", f"/api/eneo/flows/{FLOW}/runs/{DONE}/steps/"):
            with self.subTest(path=path):
                status, headers, body, _ = self.api("GET", path, user=None)

                self.assertEqual(status, 200)
                self.assertTrue(headers["content-type"].startswith("application/json"))
                json.loads(body)

    def test_a_write_names_its_user_and_a_read_need_not(self) -> None:
        runs = f"/api/eneo/flows/{FLOW}/runs/"

        without = self.api("POST", runs, user=None, headers={"Content-Type": "application/json"}, body=b"{}")
        wrong = self.api("POST", runs, user="someone-else", headers={"Content-Type": "application/json"}, body=b"{}")
        right = self.api("POST", runs, headers={"Content-Type": "application/json"}, body=b"{}")
        read = self.api("GET", f"/api/eneo/flows/{FLOW}/published/", user=None)

        self.assertEqual((without[0], json.loads(without[2])), (409, {"detail": "user_changed"}))
        self.assertEqual(wrong[0], 409)
        self.assertEqual(right[0], 201)
        self.assertEqual(read[0], 200)

    def test_a_session_the_backend_does_not_know_is_refused_before_anything_reaches_the_stub(self) -> None:
        # (That the service key and the token reach the stub is the 200 above: the stub refuses a call without them.)
        self.cookie = self.cookie + "x"
        status, headers, _, _ = self.api("GET", "/api/eneo/flows/", user=None)

        self.assertEqual(status, 401)
        self.assertEqual(headers["x-auth-required"], "session")


class FileTests(SignedIn):
    AUDIO = f"/api/eneo/flows/{FLOW}/runs/{DONE}/input-files/{AUDIO_FILE}/audio"
    ARTIFACT = f"/api/eneo/flows/{FLOW}/runs/{DONE}/artifacts/{PDF_FILE}/content"

    def test_the_audio_streams_whole_and_as_a_range_with_the_headers_of_a_range(self) -> None:
        whole = self.api("GET", self.AUDIO, user=None)
        length = len(whole[2])
        partial = self.api("GET", self.AUDIO, user=None, headers={"Range": "bytes=0-99"})

        self.assertEqual(whole[0], 200)
        self.assertEqual(whole[1]["content-type"], "audio/wav")
        self.assertGreater(length, 100_000)
        self.assertEqual(whole[2][:4], b"RIFF")
        self.assertEqual((partial[0], len(partial[2])), (206, 100))
        self.assertEqual(partial[1]["content-range"], f"bytes 0-99/{length}")
        self.assertEqual(partial[1]["accept-ranges"], "bytes")
        self.assertEqual(partial[2], whole[2][:100])
        self.assertEqual(partial[1]["x-content-type-options"], "nosniff")

    def test_open_ended_and_suffix_ranges_answer_206_too(self) -> None:
        whole = self.api("GET", self.AUDIO, user=None)[2]
        for wanted, expected in (("bytes=100-", whole[100:]), ("bytes=-50", whole[-50:]), (f"bytes={len(whole) - 10}-{len(whole) + 99}", whole[-10:])):
            with self.subTest(wanted):
                status, headers, body, _ = self.api("GET", self.AUDIO, user=None, headers={"Range": wanted})

                self.assertEqual((status, body), (206, expected))
                self.assertTrue(headers["content-range"].startswith("bytes "))

    def test_a_range_past_the_end_is_a_416(self) -> None:
        for wanted in ("bytes=99999999-", "bytes=99999999-99999999"):
            with self.subTest(wanted):
                self.assertEqual(self.api("GET", self.AUDIO, user=None, headers={"Range": wanted})[0], 416)

    def test_a_pdf_opens_inline_in_a_frame_of_the_modules_own_origin(self) -> None:
        status, headers, body, _ = self.api("GET", f"{self.ARTIFACT}?disposition=inline", user=None)

        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/pdf")
        self.assertEqual(headers["x-frame-options"], "SAMEORIGIN")
        self.assertEqual(headers["content-security-policy"], "frame-ancestors 'self'")
        self.assertTrue(headers["content-disposition"].startswith("inline"))
        self.assertEqual(body[:5], b"%PDF-")

    def test_the_same_pdf_as_a_download_is_an_attachment_in_no_frame_of_ours(self) -> None:
        status, headers, _, _ = self.api("GET", f"{self.ARTIFACT}?disposition=attachment", user=None)

        self.assertEqual(status, 200)
        self.assertTrue(headers["content-disposition"].startswith("attachment"))
        self.assertEqual(headers["x-frame-options"], "DENY")

    def test_a_file_that_is_not_there_is_the_stubs_404(self) -> None:
        status, _, _, _ = self.api("GET", f"/api/eneo/flows/{FLOW}/runs/{DONE}/input-files/00000000-0000-4000-8000-0000000000ff/audio", user=None)

        self.assertEqual(status, 404)

    def test_the_stub_counts_the_file_streams_it_has_open(self) -> None:
        self.api("GET", self.AUDIO, user=None)

        self.eventually(lambda: self.stats()["file_streams_open"] == 0, "a stream of a finished download is still counted as open")


class LiveTests(SignedIn):
    def setUp(self) -> None:
        super().setUp()
        self.recording = f"rec-{os.urandom(6).hex()}"  # the page names its recording: the stub keeps what each one sent

    def session_stats(self) -> dict:
        return self.stats()["live_sessions"].get(self.recording, {})

    def run_live(self, scenario, *, user: str | None = USER):
        async def run():
            query = f"?recording_id={self.recording}" + (f"&expected_user={user}" if user else "")
            url = f"ws://127.0.0.1:{self.backend}/api/live/{FLOW}/{AUDIO_STEP}{query}"
            async with websocket_client.connect(url, origin=self.origin, additional_headers={"Cookie": self.cookie}, open_timeout=10) as socket_:
                return await scenario(socket_)

        return asyncio.run(run())

    def test_a_frame_of_64_kib_reaches_the_stub_and_a_word_comes_back_for_four(self) -> None:
        async def scenario(socket_):
            self.assertEqual(json.loads(await socket_.recv())["type"], "ready")
            await socket_.send(bytes(64 * KB))
            self.eventually(lambda: self.session_stats().get("frames") == 1, "the frame did not reach the stub")
            for _ in range(3):
                await socket_.send(bytes(KB))
            return json.loads(await asyncio.wait_for(socket_.recv(), 5))

        delta = self.run_live(scenario)

        self.assertEqual(delta["type"], "transcript.delta")
        self.assertEqual(self.session_stats()["bytes"], 64 * KB + 3 * KB)

    def test_a_frame_over_128_kib_closes_the_socket_with_1009_and_never_reaches_the_stub(self) -> None:
        async def scenario(socket_):
            await socket_.recv()
            await socket_.send(bytes(64 * KB))
            self.eventually(lambda: self.session_stats().get("frames") == 1, "the frame did not reach the stub")
            await socket_.send(os.urandom(128 * KB + 1))
            with self.assertRaises(ConnectionClosed) as closed:
                await asyncio.wait_for(socket_.recv(), 5)
            return closed.exception.rcvd.code

        self.assertEqual(self.run_live(scenario), 1009)
        time.sleep(0.3)
        self.assertEqual((self.session_stats()["frames"], self.session_stats()["bytes"]), (1, 64 * KB))

    def test_each_recording_has_its_own_numbers_and_the_totals_add_them_up(self) -> None:
        async def scenario(socket_):
            await socket_.recv()
            await socket_.send(bytes(2 * KB))
            self.eventually(lambda: self.session_stats().get("frames") == 1, "the frame did not reach the stub")

        self.run_live(scenario)

        stats = self.stats()
        self.assertEqual(stats["live_sessions"][self.recording]["bytes"], 2 * KB)
        self.assertEqual((stats["live_frames"], stats["live_bytes"]), (1, 2 * KB))

    def test_the_stub_sees_the_ticket_in_the_subprotocol_and_no_origin(self) -> None:
        async def scenario(socket_):
            await socket_.recv()

        self.run_live(scenario)

        seen = self.session_stats()
        self.assertEqual(seen["subprotocols"][0], "eneo-live.v1")
        self.assertTrue(seen["subprotocols"][1].startswith("ticket."))
        self.assertIsNone(seen["origin"], "Eneo sees no browser Origin: the backend opens its socket itself")

    def test_a_socket_that_names_nobody_is_closed_by_the_backend_before_a_ticket_is_asked_for(self) -> None:
        async def scenario(socket_):
            with self.assertRaises(ConnectionClosed) as closed:
                await asyncio.wait_for(socket_.recv(), 5)
            return closed.exception.rcvd.code, closed.exception.rcvd.reason

        self.assertEqual(self.run_live(scenario, user=None), (1008, "user_changed"))
        self.assertEqual(self.stats()["live_tickets"], 0)

    def test_a_ticket_is_one_use_and_the_stub_refuses_a_socket_without_one(self) -> None:
        async def scenario():
            with self.assertRaises(Exception):
                async with websocket_client.connect(f"ws://127.0.0.1:{self.stub}/api/v1/live-transcription", subprotocols=["eneo-live.v1", "ticket.nope"], open_timeout=5):
                    pass

        asyncio.run(scenario())


class UploadTests(SignedIn):
    PATH = f"/api/eneo/flows/{FLOW}/steps/{AUDIO_STEP}/runtime-files/"

    def test_an_upload_of_a_few_mb_reaches_the_stub_whole_and_the_answer_is_the_stubs(self) -> None:
        headers, body = multipart(3 * 1024 * KB)

        status, _, answer, _ = self.api("POST", self.PATH, headers=headers, body=body)

        self.assertEqual(status, 201)
        self.assertEqual(set(json.loads(answer)) >= {"id", "filename"}, True)
        log = json.loads(call(self.stub, "GET", "/__log")[2])
        self.assertEqual(len(log), 1)
        record = log[0]
        self.assertGreaterEqual(record["bytes_received"], 3 * 1024 * KB)
        self.assertLess(record["bytes_received"], 3 * 1024 * KB + 1024)
        self.assertEqual(record["request_line"], f"POST /api/v1/flows/{FLOW}/steps/{AUDIO_STEP}/runtime-files/ HTTP/1.1")
        self.assertEqual(record["how"], "Content-Length body complete")
        self.assertTrue(record["content_type"].startswith("multipart/form-data; boundary="))
        for key in ("content_length", "transfer_encoding", "expect", "connection", "seconds", "started_at", "finished_at"):
            self.assertIn(key, record)
        stats = self.stats()
        self.assertEqual((stats["uploads"], stats["last_upload_bytes"]), (1, record["bytes_received"]))

    def test_the_log_and_its_reset_are_the_baselines(self) -> None:
        headers, body = multipart(10 * KB)
        self.api("POST", self.PATH, headers=headers, body=body)
        self.api("POST", self.PATH, headers=headers, body=body)

        self.assertEqual(len(json.loads(call(self.stub, "GET", "/__log")[2])), 2)
        self.assertEqual(call(self.stub, "GET", "/__reset")[0], 200)
        self.assertEqual(json.loads(call(self.stub, "GET", "/__log")[2]), [])

    def test_the_other_upload_routes_are_a_sink_too(self) -> None:
        headers, body = multipart(5 * KB)
        for path in (f"/api/eneo/flows/{FLOW}/files/", f"/api/eneo/flows/{FLOW}/template-files/"):
            with self.subTest(path=path):
                call(self.stub, "POST", "/__stub/reset")

                status, _, _, _ = self.api("POST", path, headers=headers, body=body)

                self.assertIn(status, (200, 201))
                self.assertEqual(len(json.loads(call(self.stub, "GET", "/__log")[2])), 1)

    def test_a_file_named_for_the_gate_is_refused_as_too_long(self) -> None:
        headers, body = multipart(KB, filename="for-lang.webm")

        status, _, answer, _ = self.api("POST", self.PATH, headers=headers, body=body)

        self.assertEqual(status, 400)
        self.assertEqual(json.loads(answer)["code"], "flow_run_audio_exceeds_limit")


class DevProfileTests(Stack):
    """The stub is still the BFF the dev profile's gate uses: its own paths, no credentials, nothing changed."""

    def test_the_bff_role_answers_without_a_session_or_a_key(self) -> None:
        for path, check in (
            ("/api/auth/status", lambda body: body["authenticated"] is True and body["user"]["id"] == USER),
            ("/api/branding", lambda body: body["organization"]["name"] == "Sundsvalls kommun"),
            ("/api/eneo/flows/", lambda body: FLOW in {item["id"] for item in body["items"]}),
            (f"/api/eneo/flows/{FLOW}/published/", lambda body: body["id"] == FLOW),
            (f"/api/eneo/flows/{FLOW}/runs/{DONE}/status/", lambda body: body["status"] == "completed"),
        ):
            with self.subTest(path=path):
                status, _, body, _ = call(self.stub, "GET", path)

                self.assertEqual(status, 200)
                self.assertTrue(check(json.loads(body)))

    def test_the_bff_role_streams_audio_with_ranges_and_serves_the_pdf(self) -> None:
        audio = f"/api/eneo/flows/{FLOW}/runs/{DONE}/input-files/{AUDIO_FILE}/audio"
        partial = call(self.stub, "GET", audio, headers={"Range": "bytes=0-9"})
        pdf = call(self.stub, "GET", f"/api/eneo/flows/{FLOW}/runs/{DONE}/artifacts/{PDF_FILE}/content")

        self.assertEqual((partial[0], len(partial[2])), (206, 10))
        self.assertEqual((pdf[0], pdf[1]["content-type"]), (200, "application/pdf"))

    def test_the_bff_role_relay_still_answers_a_word_for_four_frames(self) -> None:
        async def run():
            url = f"ws://127.0.0.1:{self.stub}/api/live/{FLOW}/{AUDIO_STEP}"
            async with websocket_client.connect(url, open_timeout=5) as socket_:
                self.assertEqual(json.loads(await socket_.recv())["type"], "ready")
                for _ in range(4):
                    await socket_.send(bytes(KB))
                return json.loads(await asyncio.wait_for(socket_.recv(), 5))

        self.assertEqual(asyncio.run(run())["type"], "transcript.delta")

    def test_the_bff_role_upload_still_answers_201(self) -> None:
        headers, body = multipart(KB)
        status, _, answer, _ = call(self.stub, "POST", f"/api/eneo/flows/{FLOW}/steps/{AUDIO_STEP}/runtime-files/", headers=headers, body=body)

        self.assertEqual(status, 201)
        self.assertIn("id", json.loads(answer))


class LargeAudioTests(SignedIn):
    """files.audioLarge: 256 MiB of WAV that is made as it is read, 64 KiB at a time with a pause, so a stream can be left or stopped."""

    SIZE = 256 * KB * KB
    PATH = f"/api/eneo/flows/{FLOW}/runs/{DONE}/input-files/{AUDIO_LARGE}/audio"

    def open(self, range_: str | None = None) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
        """The page's request for the audio, through the backend, with the body left unread."""
        connection = http.client.HTTPConnection("127.0.0.1", self.backend, timeout=30)
        connection.request("GET", self.PATH, headers={"Cookie": self.cookie, **({"Range": range_} if range_ else {})})
        return connection, connection.getresponse()

    def read(self, range_: str) -> tuple[int, dict[str, str], bytes]:
        connection, response = self.open(range_)
        try:
            return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
        finally:
            connection.close()

    def stub_rss_mib(self) -> float:
        return int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(self.stub_process.pid)])) / KB

    def test_it_is_a_wav_of_256_mib_that_a_range_can_read_anywhere_in(self) -> None:
        status, headers, head = self.read("bytes=0-43")
        self.assertEqual((status, headers["content-range"]), (206, f"bytes 0-43/{self.SIZE}"))
        self.assertEqual((head[:4], head[8:16]), (b"RIFF", b"WAVEfmt "))
        self.assertEqual((struct.unpack("<I", head[4:8])[0], struct.unpack("<I", head[40:44])[0]), (self.SIZE - 8, self.SIZE - 44))

        middle = 128 * KB * KB
        status, headers, body = self.read(f"bytes={middle}-{middle + 63}")
        self.assertEqual((status, headers["content-range"], body), (206, f"bytes {middle}-{middle + 63}/{self.SIZE}", bytes(64)))
        status, headers, body = self.read("bytes=-10")
        self.assertEqual((status, headers["content-range"], body), (206, f"bytes {self.SIZE - 10}-{self.SIZE - 1}/{self.SIZE}", bytes(10)))
        self.assertEqual(self.read(f"bytes={self.SIZE}-")[0], 416)

    def test_it_streams_at_a_pace_without_being_held_and_leaving_closes_its_stream(self) -> None:
        before = self.stub_rss_mib()
        connection, response = self.open()
        try:
            self.assertEqual((response.status, response.getheader("Content-Length")), (200, str(self.SIZE)))
            started = time.monotonic()
            self.assertEqual(len(response.read(KB * KB)), KB * KB)
            elapsed = time.monotonic() - started
            self.eventually(lambda: self.stats()["file_streams_open"] == 1, "the stream is open for as long as the client reads")
            self.assertGreaterEqual(elapsed, 0.1, "1 MiB is 16 pieces of 64 KiB, each followed by a pause of 10 ms")
            self.assertLess(self.stub_rss_mib() - before, 64, "the file is made as it is read: 256 MiB held would show here")
        finally:
            connection.close()
        self.eventually(lambda: self.stats()["file_streams_open"] == 0, "a client that leaves must free its stream")


if __name__ == "__main__":
    unittest.main()
