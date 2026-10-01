"""Request bodies: capped, and never read before the route's own dependencies have run.

A body is fed to the app lazily, one MiB at a time, and the test counts how many pieces the app took before it
answered. Nothing here materialises a large body. The caps are small here (4 and 8 MiB), and "over the cap" is 64 MiB.
"""

import os
import tempfile
import time
import unittest
import warnings

import httpx

os.environ.setdefault("ENEO_BACKEND_URL", "https://eneo.example.test")
os.environ.setdefault("ENEO_PUBLIC_URL", "https://eneo.example.test")
os.environ.setdefault("MODULE_PUBLIC_URL", "https://module.example.test")
os.environ.setdefault("MODULE_KEY", "speech-to-text")
os.environ.setdefault("ENEO_API_KEY", "test-key")
os.environ.setdefault("SESSION_SECRET", "x" * 48)
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("AUTH_MODE", "eneo_sso")

from pydantic import SecretStr  # noqa: E402

from app import main  # noqa: E402
from app.module_auth import SESSION_COOKIE, EneoSsoSession, ModuleUser  # noqa: E402

MiB = 1 << 20
BOUNDARY = "limitsboundary"
CAP = 4 * MiB  # max_body_bytes in these tests
UPLOAD_CAP = 8 * MiB  # max_upload_bytes in these tests
OVER = 64  # MiB: more than either cap
ORIGIN = main.settings.module_origin


class Eneo:
    """Eneo as the module's client sees it: records what it was sent, and reads an uploaded file to its end."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def request(self, **kwargs):
        self.calls.append(kwargs)
        return Answer()

    async def post(self, url, **kwargs):
        file = kwargs["files"]["upload_file"]
        self.calls.append({"url": url, "filename": file[0], "content_type": file[2], "size": len(file[1].read())})
        return Answer()


class Answer:
    content = b'{"ok":true}'
    status_code = 200
    headers = {"content-type": "application/json"}


class Lazy:
    """A request body of ``total_mib`` MiB that never exists in memory, and how many MiB of it were taken."""

    def __init__(self, total_mib: int, head: bytes = b"", tail: bytes = b"") -> None:
        self.total_mib, self.head, self.tail, self.taken = total_mib, head, tail, 0

    @property
    def length(self) -> int:
        return len(self.head) + self.total_mib * MiB + len(self.tail)

    async def stream(self):
        if self.head:
            yield self.head
        for _ in range(self.total_mib):
            self.taken += 1
            yield b"0" * MiB
        if self.tail:
            yield self.tail


def multipart_head(name: str = "upload_file", filename: str = "a.bin", content_type: str = "application/octet-stream") -> bytes:
    return (
        f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode()


MULTIPART_TAIL = f"\r\n--{BOUNDARY}--\r\n".encode()
MULTIPART = {"Content-Type": f"multipart/form-data; boundary={BOUNDARY}", "Origin": ORIGIN}


def multipart_of(total_mib: int) -> Lazy:
    return Lazy(total_mib, multipart_head(), MULTIPART_TAIL)


def a_session() -> str:
    now = int(time.time())
    return main.module_auth.sessions.create(
        EneoSsoSession(
            access_token="module-user-token",
            expires_at=now + 600,
            refresh_at=now + 300,
            session_expires_at=now + 3600,
            module_key="speech-to-text",
            tenant_id="tenant-id",
            user=ModuleUser(id="user-id", email="user@example.test"),
        )
    )


class Case(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.eneo = Eneo()
        self.addCleanup(setattr, main, "http_client", main.http_client)
        main.http_client = self.eneo
        for name, value in (("max_body_bytes", CAP), ("max_upload_bytes", UPLOAD_CAP)):
            self.addCleanup(setattr, main.settings, name, getattr(main.settings, name))
            setattr(main.settings, name, value)
        main.module_auth.sessions.clear()
        self.session_id = a_session()

    async def post(self, path: str, body: Lazy, *, authenticated: bool = True, declare_length: bool = True, headers: dict | None = None):
        sent = {"Content-Type": "application/json", **(headers or {})}
        if declare_length:
            sent["Content-Length"] = str(body.length)
        if authenticated:
            sent["Cookie"] = f"{SESSION_COOKIE}={self.session_id}"
        # raise_app_exceptions=False: a crash in the app is a 500 to assert on, not an exception in the test.
        transport = httpx.ASGITransport(app=main.app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url=ORIGIN) as client:
            return await client.post(path, content=body.stream(), headers=sent)


class JsonBodyTests(Case):
    async def test_a_body_over_the_cap_is_413_before_the_route_reads_it(self) -> None:
        declared, chunked = Lazy(OVER), Lazy(OVER)

        first = await self.post("/api/auth/login", declared, authenticated=False)
        second = await self.post("/api/auth/login", chunked, authenticated=False, declare_length=False)

        self.assertEqual((first.status_code, second.status_code), (413, 413))
        self.assertEqual(first.json(), {"detail": "Request body too large"})
        self.assertEqual(first.headers["connection"], "close")
        self.assertEqual(declared.taken, 0)
        self.assertLessEqual(chunked.taken, CAP // MiB + 2, "the rest of the body was never taken")

    async def test_the_cap_needs_no_session(self) -> None:
        for authenticated in (False, True):
            with self.subTest(authenticated=authenticated):
                body = Lazy(OVER)

                response = await self.post("/api/auth/login", body, authenticated=authenticated, declare_length=False)

                self.assertEqual(response.status_code, 413)
                self.assertLessEqual(body.taken, CAP // MiB + 2)

    async def test_the_public_login_still_works_and_is_capped_without_a_session(self) -> None:
        self.addCleanup(setattr, main.settings, "auth_mode", main.settings.auth_mode)
        self.addCleanup(setattr, main.settings, "app_access_code", main.settings.app_access_code)
        main.settings.auth_mode = "access_code"
        main.settings.app_access_code = SecretStr("test-access-code-1234")
        headers = {"Origin": ORIGIN}

        wrong = await self.post("/api/auth/login", Lazy(0, head=b'{"access_code": "wrong"}'), authenticated=False, headers=headers)
        right = await self.post("/api/auth/login", Lazy(0, head=b'{"access_code": "test-access-code-1234"}'), authenticated=False, headers=headers)
        big_body = Lazy(OVER)
        big = await self.post("/api/auth/login", big_body, authenticated=False, declare_length=False, headers=headers)

        self.assertEqual((wrong.status_code, right.status_code), (401, 200))
        self.assertEqual(right.json(), {"ok": True})
        self.assertEqual(big.status_code, 413)
        self.assertLessEqual(big_body.taken, CAP // MiB + 2)

    async def test_a_body_under_the_cap_reaches_the_route_unchanged(self) -> None:
        payload = Lazy(0, head=b'{"access_code": "' + b"a" * (3 * MiB) + b'"}')

        response = await self.post("/api/auth/login", payload, authenticated=False)

        # Past the cap's check, and into the route: it is the route that finds the body invalid (max_length 256).
        self.assertEqual(response.status_code, 422)

    async def test_a_request_that_has_no_body_is_not_counted(self) -> None:
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url=ORIGIN) as client:
            self.assertEqual((await client.get("/api/healthz")).status_code, 200)
            self.assertEqual((await client.get("/api/auth/status")).status_code, 200)


class MalformedLengthTests(Case):
    """A Content-Length that is not a plain number is a 400, never a 500 and never a body read on trust."""

    PATHS = ("/api/auth/login", "/api/eneo/flows/flow-1/runs/", "/api/eneo/flows/flow-1/files/")
    VALUES = {
        "5001 digits (int() refuses more than 4300)": "9" * 5001,
        "5001 zeros then a 1": "0" * 5000 + "1",
        "20 digits": "9" * 20,
        "negative": "-1",
        "signed": "+5",
        "a fraction": "1.5",
        "an exponent": "1e3",
        "padded with a space": " 12",
        "two numbers": "5, 5",
    }

    async def test_a_length_that_is_not_a_plain_number_is_400(self) -> None:
        for path in self.PATHS:
            for label, value in self.VALUES.items():
                with self.subTest(path=path, length=label):
                    body = Lazy(0, head=b"{}")

                    response = await self.post(
                        path, body, declare_length=False, headers={**MULTIPART, "Content-Length": value}
                    )

                    self.assertEqual(response.status_code, 400)
                    self.assertEqual(response.json(), {"detail": "Invalid Content-Length"})
                    self.assertEqual(response.headers["connection"], "close")
                    self.assertEqual(self.eneo.calls, [])

    async def test_a_length_of_a_plain_number_is_not_refused_for_its_digits(self) -> None:
        response = await self.post(
            "/api/eneo/flows/flow-1/runs/", Lazy(0, head=b"{}"), declare_length=False,
            headers={"Origin": ORIGIN, "Content-Length": "2"},
        )

        self.assertEqual(response.status_code, 200)


class ProxyBodyTests(Case):
    async def proxy(self, body: Lazy, **kwargs):
        return await self.post(
            "/api/eneo/flows/flow-1/runs/", body,
            headers={"Content-Type": "application/octet-stream", "Origin": ORIGIN, **kwargs.pop("headers", {})}, **kwargs,
        )

    async def test_a_post_over_the_cap_is_413_and_never_reaches_eneo(self) -> None:
        declared, chunked = Lazy(OVER), Lazy(OVER)

        first = await self.proxy(declared)
        second = await self.proxy(chunked, declare_length=False)

        self.assertEqual((first.status_code, second.status_code), (413, 413))
        self.assertEqual(declared.taken, 0)
        self.assertLessEqual(chunked.taken, CAP // MiB + 2)
        self.assertEqual(self.eneo.calls, [])

    async def test_a_post_under_the_cap_is_forwarded_byte_for_byte(self) -> None:
        payload = os.urandom(3 * MiB + 17)

        response = await self.proxy(Lazy(0, head=payload))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.eneo.calls[-1]["content"], payload)
        self.assertEqual(self.eneo.calls[-1]["url"], "https://eneo.example.test/api/v1/flows/flow-1/runs/")

    async def test_a_multipart_content_type_does_not_get_a_bigger_cap_through_the_proxy(self) -> None:
        # The upload cap is for the upload routes: through the proxy, a body that calls itself multipart gets none.
        multipart = {"Content-Type": f"multipart/form-data; boundary={BOUNDARY}"}
        declared_between, chunked = multipart_of(6), multipart_of(OVER)  # 6 MiB: over max_body_bytes, under max_upload_bytes

        first = await self.proxy(declared_between, headers=multipart)
        second = await self.proxy(chunked, declare_length=False, headers=multipart)

        self.assertEqual((first.status_code, second.status_code), (413, 413))
        self.assertLessEqual(declared_between.taken, CAP // MiB + 2)
        self.assertLessEqual(chunked.taken, CAP // MiB + 2)
        self.assertEqual(self.eneo.calls, [])

    async def test_an_unauthenticated_post_is_a_401_and_the_body_is_unread(self) -> None:
        body = multipart_of(6)  # within the upload cap: the dependencies answer before a byte is read

        response = await self.proxy(body, authenticated=False, headers={"Content-Type": f"multipart/form-data; boundary={BOUNDARY}"})

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.headers["x-auth-required"], "session")
        self.assertEqual(body.taken, 0)


class UploadTests(Case):
    PATH = "/api/eneo/flows/flow-1/files/"

    def setUp(self) -> None:
        super().setUp()
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.temporary = folder.name
        self.addCleanup(setattr, tempfile, "tempdir", tempfile.tempdir)
        tempfile.tempdir = folder.name

    async def upload(self, body: Lazy, **kwargs):
        return await self.post(self.PATH, body, headers=kwargs.pop("headers", MULTIPART), **kwargs)

    def open_files(self) -> int:
        return len(os.listdir("/dev/fd"))

    async def test_an_unauthenticated_upload_is_a_401_and_not_a_byte_of_it_is_read(self) -> None:
        body = multipart_of(6)  # within the upload cap, so it is the session that decides

        response = await self.upload(body, authenticated=False)

        self.assertEqual(response.status_code, 401)
        self.assertEqual(body.taken, 0)
        self.assertEqual(os.listdir(self.temporary), [])

    async def test_an_upload_over_the_cap_is_413_for_everyone_before_any_session_is_looked_at(self) -> None:
        for authenticated in (False, True):
            with self.subTest(authenticated=authenticated):
                body = multipart_of(OVER)

                response = await self.upload(body, authenticated=authenticated)

                self.assertEqual(response.status_code, 413)
                self.assertEqual(body.taken, 0)
                self.assertEqual(self.eneo.calls, [])
                self.assertEqual(os.listdir(self.temporary), [])

    async def test_an_upload_from_another_origin_is_refused_before_it_is_read(self) -> None:
        body = multipart_of(6)

        response = await self.upload(body, headers={**MULTIPART, "Origin": "http://evil.example"})

        self.assertEqual(response.status_code, 403)
        self.assertEqual(body.taken, 0)

    async def test_an_upload_under_the_cap_is_forwarded_whole_and_leaves_nothing_behind(self) -> None:
        files_before = self.open_files()

        response = await self.upload(multipart_of(6))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True})
        self.assertEqual(self.eneo.calls[-1]["size"], 6 * MiB)
        self.assertEqual(self.eneo.calls[-1]["filename"], "a.bin")
        self.assertEqual(self.eneo.calls[-1]["url"], "https://eneo.example.test/api/v1/flows/flow-1/files/")
        self.assertEqual(os.listdir(self.temporary), [])
        self.assertEqual(self.open_files(), files_before)

    async def test_each_upload_route_answers_on_both_paths_and_forwards_to_its_own_eneo_route(self) -> None:
        routes = {
            "/api/eneo/flows/f1/files": "flows/f1/files/",
            "/api/eneo/flows/f1/steps/s1/runtime-files": "flows/f1/steps/s1/runtime-files/",
            "/api/eneo/flows/f1/template-files": "flows/f1/template-files/",
        }
        for path, upstream in routes.items():
            for suffix in ("", "/"):
                with self.subTest(path=path + suffix):
                    response = await self.post(path + suffix, multipart_of(1), headers=MULTIPART)

                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(self.eneo.calls[-1]["url"], f"https://eneo.example.test/api/v1/{upstream}")
                    self.assertEqual(self.eneo.calls[-1]["size"], MiB)

    async def test_a_flow_id_that_leaves_its_route_is_403_before_the_body_is_read(self) -> None:
        body = multipart_of(6)

        response = await self.post("/api/eneo/flows/%2E%2E/files/", body, headers=MULTIPART)

        self.assertEqual(response.status_code, 403)
        self.assertEqual(body.taken, 0)
        self.assertEqual(self.eneo.calls, [])

    async def test_an_upload_without_a_length_is_411_and_never_read(self) -> None:
        body = multipart_of(OVER)

        response = await self.upload(body, declare_length=False)

        self.assertEqual(response.status_code, 411)
        self.assertEqual(response.json(), {"detail": "Content-Length required"})
        self.assertLessEqual(body.taken, 1)
        self.assertEqual(self.eneo.calls, [])
        self.assertEqual(os.listdir(self.temporary), [])

    async def test_an_upload_that_lies_about_its_length_is_stopped_at_the_upload_cap(self) -> None:
        # Declares 1 MiB and sends 64: a chunked body with a Content-Length beside it, or a lie the server does not catch.
        body = multipart_of(OVER)

        response = await self.upload(body, declare_length=False, headers={**MULTIPART, "Content-Length": str(MiB)})

        self.assertEqual(response.status_code, 413)
        self.assertLessEqual(body.taken, UPLOAD_CAP // MiB + 2)
        self.assertEqual(self.eneo.calls, [])
        self.assertEqual(os.listdir(self.temporary), [])

    async def test_a_multipart_content_type_does_not_lift_the_cap_on_a_json_route(self) -> None:
        for authenticated in (False, True):
            with self.subTest(authenticated=authenticated):
                body = Lazy(OVER)

                response = await self.post(
                    "/api/auth/login", body, authenticated=authenticated, declare_length=False,
                    headers={"Content-Type": f"multipart/form-data; boundary={BOUNDARY}"},
                )

                self.assertEqual(response.status_code, 413)
                self.assertLessEqual(body.taken, CAP // MiB + 2, "FastAPI reads a body whatever its content type says")

    async def test_a_text_field_beside_the_file_is_a_400_and_the_rest_is_not_read(self) -> None:
        field = f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n'.encode()
        body = Lazy(7, field + multipart_head(), MULTIPART_TAIL)

        response = await self.upload(body)

        self.assertEqual(response.status_code, 400)
        self.assertLessEqual(body.taken, 1, "the parse stopped at the field, it did not spool the file first")
        self.assertEqual(self.eneo.calls, [])
        self.assertEqual(os.listdir(self.temporary), [])

    async def test_a_file_under_another_name_or_a_second_file_is_a_400(self) -> None:
        other_name = Lazy(1, multipart_head(name="file"), MULTIPART_TAIL)
        two_files = Lazy(1, multipart_head() + b"x\r\n" + multipart_head(), MULTIPART_TAIL)

        self.assertEqual((await self.upload(other_name)).status_code, 400)
        self.assertEqual((await self.upload(two_files)).status_code, 400)
        self.assertEqual(self.eneo.calls, [])

    async def test_a_body_that_is_not_multipart_is_a_400(self) -> None:
        response = await self.upload(Lazy(0, head=b'{"a": 1}'), headers={"Content-Type": "application/json", "Origin": ORIGIN})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.eneo.calls, [])

    async def test_a_multipart_body_that_cannot_be_parsed_is_a_400_never_a_500(self) -> None:
        cases = {
            "no boundary in the content type": (b"whatever", {"Content-Type": "multipart/form-data", "Origin": ORIGIN}),
            "no part at all": (b"just some text", MULTIPART),
            "a part header that is not one": (f"--{BOUNDARY}\r\nno colon here\r\n\r\nx\r\n--{BOUNDARY}--\r\n".encode(), MULTIPART),
        }
        for label, (content, headers) in cases.items():
            with self.subTest(label):
                response = await self.upload(Lazy(0, head=content), headers=headers)

                self.assertEqual(response.status_code, 400)
        self.assertEqual(self.eneo.calls, [])
        self.assertEqual(os.listdir(self.temporary), [])

    async def test_a_file_part_that_never_ends_is_a_400_and_leaves_nothing_behind(self) -> None:
        files_before = self.open_files()

        with warnings.catch_warnings():
            # Starlette leaves the file of a part that never ends to be closed when its parser is collected, which
            # CPython does at once; what the app is held to is that nothing is left open or on disk.
            warnings.simplefilter("ignore", ResourceWarning)
            response = await self.upload(Lazy(4, multipart_head(), b""))

        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.eneo.calls, [])
        self.assertEqual(os.listdir(self.temporary), [])
        self.assertEqual(self.open_files(), files_before)

    async def test_a_control_character_in_the_file_name_or_content_type_is_a_400_and_is_never_forwarded(self) -> None:
        # What a browser cannot send but an attacker can, and what Starlette hands on: a line break in the quoted
        # file name or in the part's content type would be written into the part headers sent to Eneo.
        cases = {
            "bare LF in the content type": multipart_head(content_type="audio/webm\nX-Injected: 1"),
            "bare LF in the file name": multipart_head(filename="a\nX-Injected: 1.webm"),
            "NUL in the file name": multipart_head(filename="a\x00b.webm"),
            "tab in the file name": multipart_head(filename="a\tb.webm"),
            "DEL in the content type": multipart_head(content_type="audio/webm\x7f"),
        }
        for label, head in cases.items():
            with self.subTest(label):
                response = await self.upload(Lazy(1, head, MULTIPART_TAIL))

                self.assertEqual(response.status_code, 400)
        self.assertEqual(self.eneo.calls, [])

    async def test_a_crlf_cannot_get_a_header_of_its_own_to_eneo(self) -> None:
        # The parser ends the value at the line break: the rest is a part header of its own, which is dropped.
        for label, head in {
            "in the content type": multipart_head(content_type="audio/webm\r\nX-Injected: 1"),
            "in the file name": multipart_head(filename="a\r\nX-Injected: 1.webm"),
        }.items():
            with self.subTest(label):
                self.eneo.calls.clear()

                response = await self.upload(Lazy(1, head, MULTIPART_TAIL))

                self.assertIn(response.status_code, (200, 400))
                for call in self.eneo.calls:
                    self.assertFalse(any(c < " " for c in call["filename"] + call["content_type"]))
                    self.assertNotIn("X-Injected", call["filename"] + call["content_type"])

    async def test_a_file_name_with_spaces_and_non_ascii_letters_is_forwarded(self) -> None:
        response = await self.upload(Lazy(1, multipart_head(filename="möte ett.webm", content_type="audio/webm"), MULTIPART_TAIL))

        self.assertEqual(response.status_code, 200)
        self.assertEqual((self.eneo.calls[-1]["filename"], self.eneo.calls[-1]["content_type"]), ("möte ett.webm", "audio/webm"))

    async def test_aborted_uploads_leave_no_file_open_and_no_temporary_file(self) -> None:
        # The client goes away after 4 MiB, which is more than a spooled file keeps in memory.
        files_before = self.open_files()
        for _ in range(8):
            await self.abort_upload(4)

        self.assertEqual(os.listdir(self.temporary), [])
        self.assertEqual(self.open_files(), files_before, "no collection of garbage was needed to close them")

    async def abort_upload(self, total_mib: int) -> None:
        """One upload, fed straight to the app, that is dropped after ``total_mib``."""
        pieces = [multipart_head()] + [b"0" * MiB] * total_mib
        headers = {**MULTIPART, "Content-Length": str(len(pieces[0]) + (total_mib + 3) * MiB), "Cookie": f"{SESSION_COOKIE}={self.session_id}"}
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http", "path": self.PATH,
            "raw_path": self.PATH.encode(), "query_string": b"", "root_path": "", "client": ("127.0.0.1", 1), "server": ("module.example.test", 80),
            "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        }
        queue = iter(pieces)

        async def receive():
            piece = next(queue, None)
            if piece is None:
                return {"type": "http.disconnect"}
            return {"type": "http.request", "body": piece, "more_body": True}

        async def send(message) -> None:
            pass

        try:
            await main.app(scope, receive, send)
        except Exception:  # the dropped connection surfaces as an error the server logs; what matters is what is left
            pass


if __name__ == "__main__":
    unittest.main()
