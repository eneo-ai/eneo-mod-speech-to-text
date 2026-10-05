"""No log record carries a URL with a token in it, or any secret, however a call to Eneo ends.

The app logs at INFO (main.py), and httpx logs every request's full URL at INFO: Eneo's signed file URL carries its
bearer token in the query string. Each flow below runs through the real app and a real httpx client whose transport
answers from the test; distinct dummy sentinels stand for every secret that is on the wire, and none may appear in any
record the root logger sees (its message, its arguments, its traceback). The failures keep the safe fields that diagnose
them: a status, a path template, a fixed sentence.
"""

import io
import logging
import os
import time
import unittest
from datetime import datetime, timedelta, timezone

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "http://localhost:3002")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402
from websockets.exceptions import InvalidStatus  # noqa: E402

from app import main  # noqa: E402
from app.module_auth import EneoSsoSession, ModuleUser, SESSION_COOKIE  # noqa: E402

ORIGIN = "http://localhost:3002"
FLOW, STEP = "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"
# One distinct dummy per secret that is on the wire, so a hit says which one leaked.
FILE_TOKEN = "SENTINEL-signed-file-token"
TICKET = "SENTINEL-login-ticket"
LIVE_TICKET = "SENTINEL-live-ticket"
ACCESS = "SENTINEL-module-access-token"
REFRESH_ACCESS = "SENTINEL-refreshed-access-token"
SESSION_ID_NOTE = "SENTINEL-session"
SENTINELS = (FILE_TOKEN, TICKET, LIVE_TICKET, ACCESS, REFRESH_ACCESS, SESSION_ID_NOTE)
SIGNED = f"https://eneo.example.test/api/v1/files/file-1/download/?token={FILE_TOKEN}"
AUDIO = "/api/eneo/flows/flow-1/runs/run-1/input-files/file-1/audio"


class Capture(logging.Handler):
    """Every record the root logger sees, as it would be written: message, arguments and traceback.

    Not the records of the test's own client for its own calls to the app (http://testserver/...): in production those
    are the browser's, which no httpx logger sees.
    """

    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.lines: list[str] = []
        self.setFormatter(logging.Formatter("%(name)s %(levelname)s %(message)s"))

    def emit(self, record: logging.LogRecord) -> None:
        if record.name == "httpx" and "http://testserver" in record.getMessage():
            return
        self.lines.append(self.format(record))

    @property
    def text(self) -> str:
        return "\n".join(self.lines)


class Body(httpx.AsyncByteStream):
    """An answer's body, read from the wire as it is used: httpx.Response(content=...) arrives already read."""

    def __init__(self, content: bytes) -> None:
        self.content = content

    async def __aiter__(self):
        yield self.content


def streamed(status: int, content: bytes = b"", **headers: str) -> httpx.Response:
    return httpx.Response(status, headers=headers, stream=Body(content))

    @property
    def text(self) -> str:
        return "\n".join(self.lines)


def token_payload(access_token: str, user_id: str = "user-id") -> dict[str, object]:
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "expires_in": 900,
        "session_expires_at": (datetime.now(timezone.utc) + timedelta(hours=4)).isoformat(),
        "module_key": "speech-to-text",
        "tenant_id": "tenant-id",
        "user": {"id": user_id, "email": "user@example.test", "username": "Test User"},
    }


class LogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.answer = lambda request: httpx.Response(500)
        self.real = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: self.answer(request)), follow_redirects=False)
        self.original = main.http_client, main.module_auth.http_client
        main.http_client = main.module_auth.http_client = self.real
        main._signed_urls.clear()
        main.module_auth.sessions.clear()
        # The app configures logging at import (INFO); the test says so too, whatever ran before it.
        root = logging.getLogger()
        self.root_level = root.level
        root.setLevel(logging.INFO)
        self.capture = Capture()
        root.addHandler(self.capture)
        self.client = TestClient(main.app, follow_redirects=False)
        self.client.headers["X-Expected-User"] = "user-id"

    def tearDown(self) -> None:
        root = logging.getLogger()
        root.removeHandler(self.capture)
        root.setLevel(self.root_level)
        main.http_client, main.module_auth.http_client = self.original
        main._signed_urls.clear()
        main.module_auth.sessions.clear()

    def sign_in(self, *, refresh_at: int | None = None) -> None:
        now = int(time.time())
        session = EneoSsoSession(
            access_token=ACCESS, expires_at=now + 600, refresh_at=refresh_at if refresh_at is not None else now + 300,
            session_expires_at=now + 3600, module_key="speech-to-text", tenant_id="tenant-id",
            user=ModuleUser(id="user-id", email="user@example.test"),
        )
        self.client.cookies.set(SESSION_COOKIE, main.module_auth.sessions.create(session))

    def assert_clean(self, diagnosis: str | None = None) -> None:
        text = self.capture.text
        for sentinel in SENTINELS:
            self.assertNotIn(sentinel, text, f"{sentinel} was logged:\n{text}")
        self.assertNotIn("token=", text, text)
        if diagnosis is not None:
            self.assertIn(diagnosis, text, "the failure no longer says what happened")

    def test_the_http_libraries_are_held_at_warning_whatever_the_root_logger_says(self) -> None:
        for name in ("httpx", "httpcore"):
            self.assertGreaterEqual(logging.getLogger(name).getEffectiveLevel(), logging.WARNING, name)

    # ---- SSO login and callback

    def start_login(self) -> str:
        location = self.client.get("/api/auth/login").headers["location"]
        return httpx.URL(location).params["state"]

    def test_a_login_that_succeeds_logs_no_secret(self) -> None:
        def answer(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/token/"):
                return httpx.Response(200, json=token_payload(ACCESS))
            return httpx.Response(200, json={k: v for k, v in token_payload(ACCESS).items() if k in ("module_key", "tenant_id", "user")})

        self.answer = answer
        state = self.start_login()

        callback = self.client.get("/api/auth/callback", params={"ticket": TICKET, "state": state})

        self.assertEqual(callback.headers["location"], "/flows")
        self.assert_clean()

    def test_a_login_that_fails_logs_what_happened_and_no_secret(self) -> None:
        cases = {
            "the exchange refused": (lambda request: httpx.Response(401, json={"detail": f"bad ticket {TICKET}"}), "Module ticket exchange failed with status 401"),
            "the exchange unreachable": (lambda request: (_ for _ in ()).throw(httpx.ConnectError("connection refused")), "Module ticket exchange could not reach Eneo"),
            "the exchange answered nonsense": (lambda request: httpx.Response(200, json={"access_token": ACCESS, "token_type": "nonsense"}), "Module ticket exchange returned an invalid response"),
        }
        for label, (answer, diagnosis) in cases.items():
            with self.subTest(label):
                self.capture.lines.clear()
                self.answer = answer
                state = self.start_login()

                callback = self.client.get("/api/auth/callback", params={"ticket": TICKET, "state": state})

                self.assertTrue(callback.headers["location"].startswith("/?auth_error="), callback.headers["location"])
                self.assert_clean(diagnosis)

    # ---- a signed file stream

    def signed_file_answer(self, file_answer):
        def answer(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/signed-url/"):
                return httpx.Response(200, json={"url": SIGNED, "expires_at": int(time.time()) + 900})
            return file_answer(request)

        return answer

    def test_a_signed_file_stream_never_logs_the_url_with_its_token(self) -> None:
        self.answer = self.signed_file_answer(lambda request: streamed(200, b"0123456789", **{"content-type": "audio/webm"}))
        self.sign_in()

        response = self.client.get(AUDIO)

        self.assertEqual((response.status_code, response.content), (200, b"0123456789"))
        self.assert_clean()

    def test_a_signed_file_stream_that_fails_logs_what_happened_and_no_token(self) -> None:
        cases = {
            "the file is gone": (lambda request: streamed(404, f'{{"detail": "no {FILE_TOKEN}"}}'.encode(), **{"content-type": "application/json"}), 404, None),
            "the file server fails": (lambda request: streamed(500, b"boom"), 500, None),
            "the file server is unreachable": (lambda request: (_ for _ in ()).throw(httpx.ConnectError("connection refused")), 502, "File stream request failed: path=flows/flow-1/runs/run-1/input-files/file-1/signed-url/"),
            "the file is a redirect": (lambda request: streamed(307, location=f"https://elsewhere.example/?token={FILE_TOKEN}"), 502, "File stream was answered with a redirect: path=flows/flow-1/runs/run-1/input-files/file-1/signed-url/"),
        }
        for label, (file_answer, status, diagnosis) in cases.items():
            with self.subTest(label):
                self.capture.lines.clear()
                main._signed_urls.clear()
                self.answer = self.signed_file_answer(file_answer)
                self.sign_in()

                response = self.client.get(AUDIO)

                self.assertEqual(response.status_code, status)
                self.assert_clean(diagnosis)

    # ---- an upload

    def test_an_upload_logs_no_secret_whether_it_succeeds_or_fails(self) -> None:
        cases = {
            "succeeds": (lambda request: httpx.Response(200, json={"id": "file-1"}), 200, None),
            "is refused": (lambda request: httpx.Response(422, json={"detail": f"bad {ACCESS}"}), 422, None),
            "times out": (lambda request: (_ for _ in ()).throw(httpx.ReadTimeout("read timed out")), 504, "Upload timed out: url=https://eneo.example.test/api/v1/flows/flow-1/files/"),
            "is unreachable": (lambda request: (_ for _ in ()).throw(httpx.ConnectError("connection refused")), 502, "Upload failed: url=https://eneo.example.test/api/v1/flows/flow-1/files/"),
        }
        for label, (answer, status, diagnosis) in cases.items():
            with self.subTest(label):
                self.capture.lines.clear()
                self.answer = answer
                self.sign_in()

                response = self.client.post(
                    "/api/eneo/flows/flow-1/files/",
                    headers={"Origin": ORIGIN},
                    files={"upload_file": (f"{SESSION_ID_NOTE}.webm", b"audio", "audio/webm")},
                )

                self.assertEqual(response.status_code, status)
                self.assert_clean(diagnosis)

    # ---- a live ticket request

    def live(self, answer, connect=None) -> str:
        self.answer = answer
        self.sign_in()
        original = main._ConnectWithoutRedirects
        if connect is not None:
            main._ConnectWithoutRedirects = connect
        self.addCleanup(setattr, main, "_ConnectWithoutRedirects", original)
        url = f"/api/live/{FLOW}/{STEP}?expected_user=user-id&expected_tenant=tenant-id"
        events = io.StringIO()
        try:
            with self.client.websocket_connect(url, headers={"Origin": ORIGIN}) as socket:
                events.write(str(socket.receive_json()))
        except WebSocketDisconnect:
            pass
        return events.getvalue()

    def test_a_live_ticket_request_logs_no_secret(self) -> None:
        def refused(*args, **kwargs):
            raise InvalidStatus(httpx.Response(307))  # a redirect from Eneo's socket: refused, never followed

        cases = {
            "the socket is refused": (lambda request: httpx.Response(200, json={"ticket": LIVE_TICKET, "websocket_path": "/api/v1/live/"}), refused, "Live transcription socket: Eneo refused it"),
            "the ticket is refused": (lambda request: httpx.Response(401, json={"code": "unauthorized", "message": f"no {ACCESS}"}), None, None),
            "Eneo is unreachable": (lambda request: (_ for _ in ()).throw(httpx.ConnectError("connection refused")), None, "Live transcription ticket: Eneo unreachable"),
            "the ticket is nonsense": (lambda request: httpx.Response(200, json={"ticket": 1, "websocket_path": 2, "note": LIVE_TICKET}), None, "Live transcription ticket: invalid response from Eneo"),
        }
        for label, (answer, connect, diagnosis) in cases.items():
            with self.subTest(label):
                self.capture.lines.clear()

                self.live(answer, connect)

                self.assert_clean(diagnosis)

    # ---- a refresh

    def test_a_refresh_logs_no_secret_whether_it_succeeds_or_fails(self) -> None:
        cases = {
            "succeeds": (lambda request: httpx.Response(200, json=token_payload(REFRESH_ACCESS)), True, None),
            "is refused": (lambda request: httpx.Response(401, json={"detail": f"bad {ACCESS}"}), False, "Eneo refused the module token refresh with status 401"),
            "fails upstream": (lambda request: httpx.Response(503, json={"detail": f"down {ACCESS}"}), True, "Module token refresh failed with status 503"),
            "is unreachable": (lambda request: (_ for _ in ()).throw(httpx.ConnectError("connection refused")), True, "Module token refresh could not reach Eneo"),
            "answers nonsense": (lambda request: httpx.Response(200, json={"access_token": REFRESH_ACCESS, "token_type": "nonsense"}), False, "Module token refresh returned an invalid response"),
        }
        for label, (answer, still_signed_in, diagnosis) in cases.items():
            with self.subTest(label):
                self.capture.lines.clear()
                main.module_auth.sessions.clear()
                self.answer = answer
                self.sign_in(refresh_at=int(time.time()) - 1)  # due now

                status = self.client.get("/api/auth/status")

                self.assertEqual(status.json()["authenticated"], still_signed_in)
                self.assert_clean(diagnosis)


if __name__ == "__main__":
    unittest.main()
