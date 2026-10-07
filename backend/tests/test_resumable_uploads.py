"""The browser can recover a lost part/acknowledgement without forwarding two files to Eneo."""

import asyncio
from unittest.mock import patch
from uuid import uuid4

import anyio
import httpx

from test_body_limits import Case, ORIGIN
from app import main
from app import resumable

FLOW, STEP = str(uuid4()), str(uuid4())


class ResumableTests(Case):
    async def asyncSetUp(self):
        from app.module_auth import SESSION_COOKIE
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url=ORIGIN,
            headers={"Cookie": f"{SESSION_COOKIE}={self.session_id}", "Origin": ORIGIN, "X-Expected-User": "user-id"})
        self.addAsyncCleanup(self.client.aclose)
        self.data = b"first-second"
        self.metadata = {"filename": "möte.webm", "content_type": "audio/webm", "size": len(self.data)}
        self.path = f"/api/uploads/{FLOW}/{STEP}/{uuid4()}"
        self.forwarded = []
        self.forward_started, self.release_forward = asyncio.Event(), asyncio.Event()
        self.contract_limit = 1 << 20
        self.contract_status = 200
        self.contract_types = ["audio/webm"]

        async def contract(**kwargs):
            return httpx.Response(self.contract_status, json={"steps_requiring_input": [{"step_id": STEP,
                "max_file_size_bytes": self.contract_limit, "accepted_mimetypes": self.contract_types}]})

        async def forward(url, **kwargs):
            file = kwargs["files"]["upload_file"]
            self.forwarded.append((file[0], file[1].read(), file[2]))
            self.forward_started.set()
            await self.release_forward.wait()
            return httpx.Response(201, json={"id": "eneo-file"})

        self.eneo.request, self.eneo.post = contract, forward
        # The public routes own admission; no test borrows a lease on their behalf.
        self.addCleanup(setattr, main.app.state, "upload_slots", main.app.state.upload_slots)
        main.app.state.upload_slots = anyio.CapacityLimiter(1)
        if hasattr(main.app.state, "uploads"):
            await main.app.state.uploads.close()
            self.addAsyncCleanup(main.app.state.uploads.close)

    async def create(self):
        response = await self.client.put(self.path, json=self.metadata)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def part(self, data, offset):
        return await self.client.patch(self.path, content=data,
            headers={"Upload-Offset": str(offset), "Content-Type": "application/octet-stream"})

    async def test_lost_acknowledgements_resume_and_complete_forwards_once(self):
        await self.create()
        first = await self.part(self.data[:6], 0)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["offset"], 6)
        self.assertEqual((await self.create())["offset"], 6, "a lost create/part acknowledgement retains bytes")
        duplicate = await self.part(self.data[:6], 0)
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual((await self.client.get(self.path)).json()["offset"], 6)
        self.assertEqual((await self.part(self.data[6:], 6)).status_code, 200)
        complete = await self.client.post(self.path + "/complete")
        self.assertEqual(complete.status_code, 200, complete.text)
        await asyncio.wait_for(self.forward_started.wait(), 1)
        self.assertEqual((await self.client.post(self.path + "/complete")).json()["state"], "forwarding")
        self.release_forward.set()
        for _ in range(100):
            status = (await self.client.get(self.path)).json()
            if status["state"] == "complete":
                break
            await asyncio.sleep(.01)
        self.assertEqual(status["file_id"], "eneo-file")
        self.assertEqual((await self.client.post(self.path + "/complete")).json()["file_id"], "eneo-file")
        self.assertEqual(self.forwarded, [("möte.webm", self.data, "audio/webm")])

    async def test_partial_part_times_out_and_rolls_back_before_retry(self):
        await self.create()
        self.assertEqual((await self.part(self.data[:6], 0)).status_code, 200)

        async def interrupted():
            yield b"wrong"
            await asyncio.sleep(1)

        with patch.object(main.settings, "upload_receive_idle_timeout_seconds", .02):
            answer = await self.client.patch(self.path, content=interrupted(), headers={
                "Upload-Offset": "6", "Content-Type": "application/octet-stream", "Content-Length": "6"})
        self.assertEqual(answer.status_code, 408, answer.text)
        self.assertEqual((await self.client.get(self.path)).json()["offset"], 6)
        self.assertEqual((await self.part(self.data[6:], 6)).status_code, 200)
        self.release_forward.set()
        await self.client.post(self.path + "/complete")
        await asyncio.wait_for(self.forward_started.wait(), 1)
        self.assertEqual(self.forwarded[0][1], self.data)

    async def test_owner_origin_contract_and_capacity_are_checked_before_parts(self):
        await self.create()
        other = f"/api/uploads/{FLOW}/{STEP}/{uuid4()}"
        self.assertEqual((await self.client.put(other, json=self.metadata)).status_code, 503)
        self.assertEqual((await self.client.patch(self.path, content=b"x", headers={"Origin": "https://evil.test"})).status_code, 403)
        self.assertEqual((await self.client.get(self.path, headers={"X-Expected-User": "someone-else"})).status_code, 409)
        session = main.module_auth.sessions.get(self.session_id)
        with patch.object(session, "tenant_id", "other-tenant"):
            self.assertEqual((await self.client.get(self.path)).status_code, 404)
        await self.client.delete(self.path)
        self.contract_limit = 2
        self.assertEqual((await self.client.put(other, json=self.metadata)).status_code, 413)
        self.assertFalse(self.forwarded)

    async def test_expired_upload_releases_its_spool_and_slot(self):
        with patch.object(main.settings, "upload_receive_timeout_seconds", .01):
            await self.create()
        await asyncio.sleep(.02)
        self.assertEqual((await self.client.get(self.path)).status_code, 404)
        self.path = f"/api/uploads/{FLOW}/{STEP}/{uuid4()}"
        await self.create()

    async def test_contract_rechecked_before_forward_and_oversize_part_is_not_committed(self):
        await self.create()
        self.assertEqual((await self.part(self.data + b"x", 0)).status_code, 413)
        self.assertEqual((await self.client.get(self.path)).json()["offset"], 0)
        await self.part(self.data, 0)
        self.contract_limit = 2
        self.assertEqual((await self.client.post(self.path + "/complete")).status_code, 413)
        self.assertFalse(self.forwarded)

    async def test_disconnect_and_concurrent_part_do_not_change_committed_offset(self):
        await self.create()
        writing = asyncio.Event()

        async def interrupted():
            yield b"wrong"
            writing.set()
            await asyncio.Event().wait()

        sending = asyncio.create_task(self.client.patch(self.path, content=interrupted(), headers={
            "Upload-Offset": "0", "Content-Type": "application/octet-stream", "Content-Length": str(len(self.data))}))
        await asyncio.wait_for(writing.wait(), 1)
        self.assertEqual((await self.part(self.data, 0)).status_code, 503)
        sending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await sending
        self.assertEqual((await self.client.get(self.path)).json()["offset"], 0)
        self.assertEqual((await self.part(self.data, 0)).status_code, 200)
        self.release_forward.set()
        await self.client.post(self.path + "/complete")
        await asyncio.wait_for(self.forward_started.wait(), 1)
        self.assertEqual(self.forwarded[0][1], self.data)

    async def test_abandoned_resource_expires_between_parts_and_releases_admission(self):
        with patch.object(main.settings, "upload_resume_idle_timeout_seconds", .02):
            await self.create()
        janitor = asyncio.create_task(main.app.state.uploads.sweep())
        try:
            await asyncio.sleep(1.05)
        finally:
            janitor.cancel()
            await asyncio.gather(janitor, return_exceptions=True)
        self.assertEqual((await self.client.get(self.path)).status_code, 404)
        await self.create()

    async def test_status_refreshes_idle_deadline_but_not_total_lifetime(self):
        with patch.object(main.settings, "upload_resume_idle_timeout_seconds", .4), \
             patch.object(main.settings, "upload_receive_timeout_seconds", .65):
            await self.create()
        for _ in range(2):
            await asyncio.sleep(.25)
            self.assertEqual((await self.client.get(self.path)).status_code, 200)
        await asyncio.sleep(.25)
        self.assertEqual((await self.client.get(self.path)).status_code, 404)

    async def test_old_receipts_do_not_block_new_uploads_or_evict_active_files(self):
        main.app.state.upload_slots = anyio.CapacityLimiter(2)
        self.release_forward.set()
        await self.create()
        await self.part(self.data, 0)
        await self.client.post(self.path + "/complete")
        await asyncio.wait_for(self.forward_started.wait(), 1)
        await asyncio.sleep(.02)
        finished = self.path
        self.path = f"/api/uploads/{FLOW}/{STEP}/{uuid4()}"
        await self.create()
        await self.part(self.data[:6], 0)
        active = self.path
        self.path = f"/api/uploads/{FLOW}/{STEP}/{uuid4()}"
        with patch.object(resumable, "MAX_RECEIPTS", 2):
            await self.create()
        self.assertEqual((await self.client.get(finished)).status_code, 404)
        self.assertEqual((await self.client.get(active)).json()["offset"], 6)
        self.assertEqual(len(self.forwarded), 1)

    async def test_contract_read_failure_preserves_the_completed_file_for_retry(self):
        await self.create()
        await self.part(self.data, 0)
        for status in (401, 403, 409, 503):
            with self.subTest(upstream_status=status):
                self.contract_status = status
                response = await self.client.post(self.path + "/complete")
                self.assertEqual(response.status_code, 502, response.text)
                self.assertEqual((await self.client.get(self.path)).json()["offset"], len(self.data))
        self.contract_status = 200
        self.release_forward.set()
        await self.client.post(self.path + "/complete")
        await asyncio.wait_for(self.forward_started.wait(), 1)
        self.assertEqual(len(self.forwarded), 1)

    async def test_eneo_owns_mime_alias_validation(self):
        self.metadata["content_type"] = "video/webm; codecs=opus"
        await self.create()
        await self.part(self.data, 0)
        self.release_forward.set()
        await self.client.post(self.path + "/complete")
        await asyncio.wait_for(self.forward_started.wait(), 1)
        self.assertEqual(self.forwarded[0][2], self.metadata["content_type"])

    async def test_finishing_receipt_survives_receive_deadline_during_file_cleanup(self):
        with patch.object(main.settings, "upload_receive_timeout_seconds", .1):
            await self.create()
        await self.part(self.data, 0)
        cleanup_started, cleanup_allowed = asyncio.Event(), asyncio.Event()
        release = resumable.IncomingUpload.release

        async def slow_release(entry):
            if not cleanup_started.is_set():
                cleanup_started.set()
                await cleanup_allowed.wait()
            await release(entry)

        with patch.object(resumable.IncomingUpload, "release", slow_release):
            try:
                await self.client.post(self.path + "/complete")
                await asyncio.wait_for(self.forward_started.wait(), 1)
                await asyncio.sleep(.15)
                self.release_forward.set()
                await asyncio.wait_for(cleanup_started.wait(), 1)
                response = await self.client.get(self.path)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["file_id"], "eneo-file")
            finally:
                cleanup_allowed.set()
                await asyncio.sleep(.01)

    async def test_forward_failure_is_cached_and_repeated_completion_does_not_upload_again(self):
        async def failed(url, **kwargs):
            self.forwarded.append(url)
            return httpx.Response(504, json={"detail": "Uncertain upstream result"})

        self.eneo.post = failed
        await self.create()
        await self.part(self.data, 0)
        await self.client.post(self.path + "/complete")
        for _ in range(100):
            status = (await self.client.get(self.path)).json()
            if status["state"] == "failed":
                break
            await asyncio.sleep(.01)
        self.assertEqual(status["failure"]["status"], 504)
        self.assertEqual((await self.client.post(self.path + "/complete")).json(), status)
        self.assertEqual(len(self.forwarded), 1)
