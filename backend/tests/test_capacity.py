"""Heavy operations refuse excess work before consuming its body or contacting Eneo."""

import asyncio
import json
import tempfile
import time
import unittest
from unittest.mock import patch

import httpx
import anyio
from fastapi import FastAPI, Request, WebSocket
from starlette.responses import JSONResponse, StreamingResponse
from starlette.websockets import WebSocketDisconnect
from websockets.asyncio.client import connect

from test_body_limits import Case, Lazy, MiB, MULTIPART, ORIGIN, multipart_of
from app import main
from app.module_auth import SESSION_COOKIE
from test_audio_proxy import FakeAudioClient, FakeStreamResponse
from test_live_relay import LIVE_PATH, READY, serving, ticket_response
from test_module_auth import token_payload
from test_body_limits import a_session
from app.upstream import make_client


UPLOAD = "/api/eneo/flows/flow-1/steps/step-1/runtime-files/"
AUDIO = "/api/eneo/flows/flow-1/runs/run-1/input-files/file-1/audio"


class UploadAdmissionTests(Case):
    async def test_busy_upload_reads_no_body_and_capacity_returns_after_completion(self) -> None:
        receiving, finish = asyncio.Event(), asyncio.Event()
        body = multipart_of(2)

        async def held():
            yield body.head
            receiving.set()
            await finish.wait()
            yield b"x" * (2 * MiB)
            yield body.tail

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url=ORIGIN) as browser:
            first = asyncio.create_task(browser.post(UPLOAD, content=held(), headers={
                **MULTIPART, "Content-Length": str(body.length),
                "Cookie": f"{SESSION_COOKIE}={self.session_id}", "X-Expected-User": "user-id",
            }))
            try:
                await asyncio.wait_for(receiving.wait(), 2)
                rejected_body = multipart_of(2)
                rejected = await self.post(UPLOAD, rejected_body, headers=MULTIPART)
                self.assertEqual(rejected.status_code, 503)
                self.assertEqual(rejected.json()["error"], "uploads_busy")
                self.assertEqual(rejected.headers["retry-after"], "2")
                self.assertEqual(rejected_body.taken, 0)
                self.assertEqual((await browser.get("/api/auth/status")).status_code, 200)
            finally:
                finish.set()
                response = await first
            self.assertEqual(response.status_code, 200)
            self.assertEqual((await self.post(UPLOAD, multipart_of(2), headers=MULTIPART)).status_code, 200)

    async def test_idle_and_total_deadlines_close_partial_files_and_allow_the_next_upload(self) -> None:
        for mode in ("idle", "total"):
            with self.subTest(mode=mode):
                class SlowUpload(Lazy):
                    async def stream(self):
                        yield multipart_of(0).head
                        yield b"x" * (2 * MiB)
                        for _ in range(10):
                            await asyncio.sleep(0.02 if mode == "total" else 0.08)
                            yield b"x"
                        yield multipart_of(0).tail

                opened = []
                original = tempfile.SpooledTemporaryFile

                def spool(*args, **kwargs):
                    file = original(*args, **kwargs)
                    opened.append(file)
                    return file

                self.eneo.calls.clear()
                with (
                    patch.object(main.settings, "upload_receive_timeout_seconds", 0.08 if mode == "total" else 2),
                    patch.object(main.settings, "upload_receive_idle_timeout_seconds", 0.5 if mode == "total" else 0.04),
                    patch("starlette.formparsers.SpooledTemporaryFile", spool),
                ):
                    response = await self.post(UPLOAD, SlowUpload(3), headers=MULTIPART)
                self.assertEqual(response.status_code, 408)
                self.assertEqual(response.json()["error"], "upload_receive_timeout")
                self.assertTrue(opened)
                self.assertTrue(all(file.closed for file in opened))
                self.assertEqual(self.eneo.calls, [])
                self.assertEqual((await self.post(UPLOAD, multipart_of(2), headers=MULTIPART)).status_code, 200)


class FileAdmissionTests(Case):
    async def test_a_file_holds_capacity_until_cancelled_and_closed(self) -> None:
        reading = asyncio.Event()

        class HeldFile(FakeStreamResponse):
            async def aiter_raw(self):
                yield b"audio"
                reading.set()
                await asyncio.Event().wait()

        held = HeldFile(200, {"content-type": "audio/webm"}, b"")

        class Eneo(FakeAudioClient):
            async def send(self, request, stream=False):
                self.response = held if not self.stream_requests else None
                return await super().send(request, stream)

        main._signed_urls.clear()
        self.addCleanup(main._signed_urls.clear)
        with patch.object(main, "http_client", Eneo()), patch.object(main.app.state, "heavy_io_slots", anyio.CapacityLimiter(1)):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url=ORIGIN,
                                         cookies={SESSION_COOKIE: self.session_id}) as browser:
                first = asyncio.create_task(browser.get(AUDIO))
                try:
                    await asyncio.wait_for(reading.wait(), 2)
                    second = await browser.get(AUDIO)
                    self.assertEqual(second.status_code, 503)
                    self.assertEqual(second.json()["error"], "streams_busy")
                    self.assertEqual(second.headers["retry-after"], "2")
                finally:
                    first.cancel()
                    await asyncio.gather(first, return_exceptions=True)
                self.assertTrue(held.closed)
                self.assertEqual((await browser.get(AUDIO)).status_code, 200)


class MixedCapacityTests(unittest.TestCase):
    def test_uploads_files_and_live_leave_room_for_token_renewal_over_real_connections(self) -> None:
        eneo = FastAPI()
        release = asyncio.Event()
        counts = {"uploads": 0, "files": 0, "tickets": 0, "refreshes": 0}

        @eneo.get("/state")
        async def state():
            return counts

        @eneo.post("/release")
        async def finish():
            release.set()
            return {}

        @eneo.post("/api/v1/flows/{flow}/steps/{step}/runtime-files/")
        async def upload(request: Request):
            await request.body()
            counts["uploads"] += 1
            await release.wait()
            return JSONResponse({"id": "uploaded"}, headers={"Connection": "close"})

        @eneo.post("/api/v1/flows/{flow}/runs/{run}/input-files/{file}/signed-url/")
        async def mint():
            return JSONResponse({"url": f"http://127.0.0.1:{eneo_port}/file", "expires_at": time.time() + 900},
                                headers={"Connection": "close"})

        @eneo.get("/file")
        async def file():
            async def body():
                counts["files"] += 1
                yield b"audio"
                await release.wait()
                yield b"end"
            return StreamingResponse(body(), media_type="audio/webm", headers={"Connection": "close"})

        @eneo.post("/api/v1/flows/{flow}/steps/{step}/live-transcription-sessions/")
        async def ticket():
            counts["tickets"] += 1
            return JSONResponse(ticket_response().json(), headers={"Connection": "close"})

        @eneo.websocket("/api/v1/live-transcription")
        async def live(socket: WebSocket):
            await socket.accept(subprotocol="eneo-live.v1")
            await socket.send_json(READY)
            try:
                while True:
                    await socket.receive_bytes()
            except WebSocketDisconnect:
                pass

        @eneo.post("/api/v1/module-auth/speech-to-text/token/refresh/")
        async def refresh():
            counts["refreshes"] += 1
            return JSONResponse(token_payload("renewed-token"), headers={"Connection": "close"})

        @eneo.get("/api/v1/flows/")
        async def flows(request: Request):
            return JSONResponse({"authorization": request.headers.get("authorization")}, headers={"Connection": "close"})

        async def exercise(module_port: int) -> None:
            session_id = a_session()
            session = main.module_auth.sessions.get(session_id)
            headers = {"Origin": ORIGIN, "X-Expected-User": "user-id"}
            async with (
                httpx.AsyncClient(base_url=f"http://127.0.0.1:{module_port}", cookies={SESSION_COOKIE: session_id},
                                  headers=headers, timeout=20) as browser,
                httpx.AsyncClient(base_url=f"http://127.0.0.1:{eneo_port}") as control,
                connect(f"ws://127.0.0.1:{module_port}{LIVE_PATH}?expected_user=user-id", origin=ORIGIN,
                        additional_headers={"Cookie": f"{SESSION_COOKIE}={session_id}"}) as live_browser,
            ):
                self.assertEqual(json.loads(await live_browser.recv()), READY)
                tasks = [asyncio.create_task(browser.post(UPLOAD, files={"upload_file": ("a.webm", b"audio", "audio/webm")})) for _ in range(32)]
                tasks += [asyncio.create_task(browser.get(AUDIO)) for _ in range(63)]
                try:
                    async with asyncio.timeout(15):
                        while True:
                            seen = (await control.get("/state")).json()
                            if seen["uploads"] == 32 and seen["files"] == 63:
                                break
                            await asyncio.sleep(0.02)
                    self.assertEqual((await browser.get(AUDIO)).status_code, 503)
                    self.assertEqual((await browser.post(UPLOAD, files={"upload_file": ("extra.webm", b"extra")})).status_code, 503)
                    async with connect(f"ws://127.0.0.1:{module_port}{LIVE_PATH}?expected_user=user-id", origin=ORIGIN,
                                       additional_headers={"Cookie": f"{SESSION_COOKIE}={session_id}"}) as excess:
                        event = json.loads(await excess.recv())
                        self.assertEqual(event["code"], "live_busy")
                        self.assertTrue(event["retryable"])
                    session.refresh_at = int(time.time()) - 1
                    async with asyncio.timeout(3):
                        renewed = await browser.get("/api/eneo/flows/")
                        status = await browser.get("/api/auth/status")
                    self.assertEqual(renewed.status_code, 200)
                    self.assertEqual(renewed.json(), {"authorization": "Bearer renewed-token"})
                    self.assertTrue(status.json()["authenticated"])
                    self.assertEqual((await control.get("/state")).json(),
                                     {"uploads": 32, "files": 63, "tickets": 1, "refreshes": 1})
                finally:
                    await control.post("/release")
                    results = await asyncio.gather(*tasks, return_exceptions=True)
                self.assertTrue(all(isinstance(result, httpx.Response) and result.status_code == 200 for result in results),
                                [str(result) for result in results if not isinstance(result, httpx.Response) or result.status_code != 200])
                self.assertEqual((await browser.post(UPLOAD, files={"upload_file": ("next.webm", b"audio")})).status_code, 200)

        main._signed_urls.clear()
        self.addCleanup(main._signed_urls.clear)
        main.module_auth.sessions.clear()
        with serving(eneo) as (eneo_port, _), patch.object(main.settings, "eneo_backend_url", f"http://127.0.0.1:{eneo_port}"):
            upstream = make_client(main.settings)
            try:
                with (
                    patch.object(main, "http_client", upstream), patch.object(main.module_auth, "http_client", upstream),
                    patch.object(main.app.state, "upload_slots", anyio.CapacityLimiter(32)),
                    patch.object(main.app.state, "heavy_io_slots", anyio.CapacityLimiter(96)),
                    serving(main.app) as (module_port, _),
                ):
                    asyncio.run(exercise(module_port))
            finally:
                asyncio.run(upstream.aclose())
