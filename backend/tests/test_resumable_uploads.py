"""The browser can recover a lost part/acknowledgement without forwarding two files to Eneo."""

import asyncio
import errno
import io
import time
from unittest.mock import patch
from uuid import uuid4

import anyio
import httpx

from test_body_limits import Case, ORIGIN, a_session
from test_login_end import REVOKED, SessionRoute
from app import main
from app import resumable

FLOW, STEP = str(uuid4()), str(uuid4())


class Disk(io.RawIOBase):
    """The spool's disk: it takes `space["room"]` bytes more (all when None), then refuses with ENOSPC."""

    def __init__(self, space):
        self.space, self.data, self.position = space, bytearray(), 0

    def readable(self):
        return True

    def writable(self):
        return True

    def seekable(self):
        return True

    def readinto(self, buffer):
        chunk = self.data[self.position:self.position + len(buffer)]
        buffer[:len(chunk)] = chunk
        self.position += len(chunk)
        return len(chunk)

    def write(self, data):
        room = self.space["room"]
        taken = len(data) if room is None else min(len(data), room)
        if taken == 0:
            raise OSError(errno.ENOSPC, "No space left on device")
        if room is not None:
            self.space["room"] = room - taken
        self.data[self.position:self.position + taken] = bytes(data[:taken])
        self.position += taken
        return taken

    def seek(self, offset, whence=io.SEEK_SET):
        self.position = {io.SEEK_SET: 0, io.SEEK_CUR: self.position, io.SEEK_END: len(self.data)}[whence] + offset
        return self.position

    def tell(self):
        return self.position

    def truncate(self, size=None):
        size = self.position if size is None else size
        del self.data[size:]
        return size


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
        self.assertEqual(answer.json()["error"], "upload_receive_idle", "a quiet sender, as the multipart route names it")
        self.assertEqual(answer.headers["connection"], "close")
        self.assertEqual((await self.client.get(self.path)).json()["offset"], 6)
        self.assertEqual((await self.part(self.data[6:], 6)).status_code, 200)
        self.release_forward.set()
        await self.client.post(self.path + "/complete")
        await asyncio.wait_for(self.forward_started.wait(), 1)
        self.assertEqual(self.forwarded[0][1], self.data)

    async def test_a_part_still_arriving_at_the_uploads_deadline_is_a_408_without_the_quiet_senders_code(self):
        with patch.object(main.settings, "upload_receive_timeout_seconds", .2):
            await self.create()

        async def slow():
            yield b"s"
            await asyncio.sleep(1)

        answer = await self.client.patch(self.path, content=slow(), headers={
            "Upload-Offset": "0", "Content-Type": "application/octet-stream", "Content-Length": "6"})
        self.assertEqual(answer.status_code, 408, answer.text)
        self.assertEqual(answer.json(), {"detail": "The upload part timed out"}, "the page counts this one")

    async def test_a_full_spool_is_a_507_the_offset_stays_and_the_part_can_be_sent_again(self):
        import errno
        import starlette.datastructures

        await self.create()

        async def full(file, data):
            raise OSError(errno.ENOSPC, "No space left on device")

        with patch.object(starlette.datastructures.UploadFile, "write", full):
            refused = await self.part(self.data[:6], 0)
        self.assertEqual(refused.status_code, 507, refused.text)
        self.assertEqual(refused.json()["error"], "module_storage_full")
        self.assertIn("Retry-After", refused.headers)
        self.assertEqual((await self.client.get(self.path)).json()["offset"], 0, "nothing of the part is kept")
        again = await self.part(self.data[:6], 0)
        self.assertEqual(again.status_code, 200, "the part goes once there is room: nothing was left held")
        self.assertEqual(again.json()["offset"], 6)

    def spool_on(self, space):
        """Every spool from here on is buffered, as a real one, over a disk whose room the test sets."""
        patcher = patch.object(resumable.tempfile, "TemporaryFile", lambda: io.BufferedRandom(Disk(space)))
        patcher.start()
        self.addCleanup(patcher.stop)

    async def made_again_and_forwarded_whole(self):
        self.assertEqual((await self.client.get(self.path)).status_code, 404, "what the spool holds is not known: its receipt goes")
        self.assertEqual((await self.create())["offset"], 0, "the upload is made again")
        self.assertEqual((await self.part(self.data[:6], 0)).status_code, 200)
        self.assertEqual((await self.part(self.data[6:], 6)).status_code, 200)
        self.release_forward.set()
        await self.client.post(self.path + "/complete")
        await asyncio.wait_for(self.forward_started.wait(), 1)
        self.assertEqual(self.forwarded[0][1], self.data)

    async def test_a_part_the_full_disk_takes_only_in_part_is_a_507_and_the_upload_is_made_again(self):
        space = {"room": None}
        self.spool_on(space)
        await self.create()
        self.assertEqual((await self.part(self.data[:6], 0)).status_code, 200)
        # Two bytes of the next part fit; the rest stays in the spool's buffer, which the full disk refuses again.
        space["room"] = 2
        refused = await self.part(self.data[6:], 6)
        self.assertEqual(refused.status_code, 507, refused.text)
        space["room"] = None
        await self.made_again_and_forwarded_whole()

    async def test_a_rollback_the_full_disk_refuses_leaves_no_receipt_and_the_upload_is_forwarded_whole(self):
        space = {"room": None}
        self.spool_on(space)
        await self.create()
        self.assertEqual((await self.part(self.data[:6], 0)).status_code, 200)
        # The next part's first bytes wait in the spool's buffer when its sender goes quiet; going back to the last whole
        # part writes them first, and the disk takes one byte of them.
        space["room"] = 1

        async def interrupted():
            yield b"sec"
            await asyncio.sleep(1)

        with patch.object(main.settings, "upload_receive_idle_timeout_seconds", .02):
            answer = await self.client.patch(self.path, content=interrupted(), headers={
                "Upload-Offset": "6", "Content-Type": "application/octet-stream", "Content-Length": "6"})
        self.assertEqual(answer.status_code, 408, answer.text)
        space["room"] = None
        await self.made_again_and_forwarded_whole()

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

    async def test_a_taken_upload_place_is_answered_as_the_multipart_route_answers_it(self):
        await self.create()
        waiting = f"/api/uploads/{FLOW}/{STEP}/{uuid4()}"
        busy = await self.client.put(waiting, json=self.metadata)
        self.assertEqual(busy.status_code, 503)
        self.assertEqual(busy.json()["error"], "uploads_busy", "the client tells a full module from a failing one by the code")
        self.assertEqual(busy.headers["retry-after"], "2")
        # A person who cancels while waiting leaves nothing behind: no upload was made, so there is none to remove.
        self.assertEqual((await self.client.get(waiting)).status_code, 404)
        self.assertEqual((await self.client.delete(self.path)).status_code, 204)
        self.assertEqual((await self.client.put(waiting, json=self.metadata)).status_code, 200, "the place is free again")

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

    async def test_a_part_renews_the_idle_window_but_not_the_total_lifetime(self):
        with patch.object(main.settings, "upload_resume_idle_timeout_seconds", .5), \
             patch.object(main.settings, "upload_receive_timeout_seconds", .9):
            await self.create()
        await asyncio.sleep(.3)
        self.assertEqual((await self.part(self.data[:6], 0)).status_code, 200)
        await asyncio.sleep(.3)
        self.assertEqual((await self.client.get(self.path)).status_code, 200, "the part renewed the window")
        self.assertEqual((await self.part(self.data[6:], 6)).status_code, 200)
        await asyncio.sleep(.4)
        self.assertEqual((await self.client.get(self.path)).status_code, 404, "the total lifetime is over")

    async def quiet_part(self, offset):
        """A part whose sender goes quiet after its first byte."""
        async def quiet():
            yield b"s"
            await asyncio.sleep(1)

        with patch.object(main.settings, "upload_receive_idle_timeout_seconds", .05):
            answer = await self.client.patch(self.path, content=quiet(), headers={
                "Upload-Offset": str(offset), "Content-Type": "application/octet-stream", "Content-Length": "6"})
        self.assertEqual(answer.json().get("error"), "upload_receive_idle", answer.text)

    async def dropped_part(self):
        """A part whose connection is lost after its first byte."""
        writing = asyncio.Event()

        async def dropped():
            yield b"s"
            writing.set()
            await asyncio.Event().wait()

        sending = asyncio.create_task(self.client.patch(self.path, content=dropped(), headers={
            "Upload-Offset": "0", "Content-Type": "application/octet-stream", "Content-Length": "6"}))
        await asyncio.wait_for(writing.wait(), 1)
        sending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await sending

    async def place_freed_one_window_after(self, stall=None):
        """The upload is made with an idle window of .6 s, stalls (`stall`: a part that does not arrive; None: no part
        at all) and is looked up again for half that window, counted from its first stall or its making. Another sender
        is refused the only place inside the window and gets it once the window has passed."""
        with patch.object(main.settings, "upload_resume_idle_timeout_seconds", .6):
            await self.create()
        if stall:
            await stall()
        since, other = time.monotonic(), f"/api/uploads/{FLOW}/{STEP}/{uuid4()}"
        self.assertEqual((await self.client.put(other, json=self.metadata)).status_code, 503, "the place is held")
        while time.monotonic() - since < .3:
            if stall:
                await stall()
            await self.create()
            self.assertEqual((await self.client.get(self.path)).status_code, 200)
            await asyncio.sleep(.05)
        await asyncio.sleep(since + .85 - time.monotonic())
        taken = await self.client.put(other, json=self.metadata)
        self.assertEqual(taken.status_code, 200, "no lookup since the first stall kept the place")

    async def test_a_part_that_stalls_again_and_again_frees_the_place_one_window_after_the_first_stall(self):
        await self.place_freed_one_window_after(lambda: self.quiet_part(0))

    async def test_a_part_that_arrives_after_a_stall_starts_a_whole_new_window(self):
        with patch.object(main.settings, "upload_resume_idle_timeout_seconds", .6):
            await self.create()
        await self.quiet_part(0)
        stalled = time.monotonic()
        await asyncio.sleep(.25)
        self.assertEqual((await self.part(self.data[:6], 0)).status_code, 200)
        await asyncio.sleep(stalled + .7 - time.monotonic())
        self.assertEqual((await self.client.get(self.path)).json()["offset"], 6, "the window runs from the part")
        await self.quiet_part(6)
        stalled = time.monotonic()
        await asyncio.sleep(.3)
        self.assertEqual((await self.client.get(self.path)).status_code, 200, "a stall after the part gets its own window")
        await asyncio.sleep(stalled + .8 - time.monotonic())
        self.assertEqual((await self.client.get(self.path)).status_code, 404, "which no lookup extends")

    async def test_a_part_that_outlasts_the_window_and_then_stalls_keeps_what_was_received_for_one_window(self):
        with patch.object(main.settings, "upload_resume_idle_timeout_seconds", .25):
            await self.create()
        self.assertEqual((await self.part(self.data[:6], 0)).status_code, 200)

        async def slow_then_quiet():
            for _ in range(5):
                yield b"s"
                await asyncio.sleep(.08)
            await asyncio.sleep(1)

        with patch.object(main.settings, "upload_receive_idle_timeout_seconds", .2):
            answer = await self.client.patch(self.path, content=slow_then_quiet(), headers={
                "Upload-Offset": "6", "Content-Type": "application/octet-stream", "Content-Length": "6"})
        self.assertEqual(answer.json().get("error"), "upload_receive_idle", answer.text)
        status = await self.client.get(self.path)
        self.assertEqual(status.status_code, 200, "the part used up the window itself: one more from its end")
        self.assertEqual(status.json()["offset"], 6, "with what was received before it")
        await asyncio.sleep(.45)
        self.assertEqual((await self.client.get(self.path)).status_code, 404, "one window only")

    async def test_lookups_alone_or_lost_connections_free_the_place_after_one_window(self):
        for stall in (None, self.dropped_part):
            with self.subTest(stall=stall and stall.__name__):
                self.path = f"/api/uploads/{FLOW}/{STEP}/{uuid4()}"
                try:
                    await self.place_freed_one_window_after(stall)
                finally:
                    await main.app.state.uploads.close()  # every upload of this round, and the place with them

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

    def refused_by_eneo(self, *, confirmed: bool) -> SessionRoute:
        """Eneo refuses the forwarded file with a token it no longer takes, once the test releases it; its session
        route refuses the token too (``confirmed``: the login has ended) or accepts it."""
        async def refused(url, **kwargs):
            self.forwarded.append(url)
            self.forward_started.set()
            await self.release_forward.wait()
            return httpx.Response(401, json=REVOKED)

        self.eneo.post = refused
        route = SessionRoute(httpx.Response(401, json=REVOKED) if confirmed else httpx.Response(200, json={}))
        self.addCleanup(setattr, main.module_auth, "http_client", main.module_auth.http_client)
        main.module_auth.http_client = route
        return route

    async def completed(self):
        """The whole file sent and its completion asked: the receipt, forwarding."""
        await self.create()
        await self.part(self.data, 0)
        self.assertEqual((await self.client.post(self.path + "/complete")).json()["state"], "forwarding")
        await asyncio.wait_for(self.forward_started.wait(), 1)
        (entry,) = main.app.state.uploads._entries.values()
        return entry

    def signed_in_again(self) -> dict[str, str]:
        """The same user's new login: another session, whose cookie the browser sends from now on."""
        return {"Cookie": f"{main.SESSION_COOKIE}={a_session()}"}

    def assert_session_answer(self, response):
        self.assertEqual(response.status_code, 401, response.text)
        self.assertEqual(response.headers.get("x-auth-required"), "session")
        self.assertEqual(response.json(), {"detail": "Not authenticated"})

    async def test_a_login_eneo_ends_during_the_forward_fails_the_receipt_with_the_session_answer(self):
        route = self.refused_by_eneo(confirmed=True)
        heavy, uploads = main.app.state.heavy_io_slots.borrowed_tokens, main.app.state.upload_slots.borrowed_tokens
        entry = await self.completed()
        self.release_forward.set()
        await asyncio.wait_for(asyncio.shield(entry.task), 1)

        # The session is gone: the next status read asks for a new login, and the page keeps its file.
        self.assert_session_answer(await self.client.get(self.path))
        self.assertIsNone(main.module_auth.sessions.get(self.session_id))
        self.assertEqual(len(route.calls), 1)
        # The spool and the capacity it held are let go, as after any failure.
        self.assertTrue(entry.file.file.closed)
        self.assertEqual(main.app.state.heavy_io_slots.borrowed_tokens, heavy)
        self.assertEqual(main.app.state.upload_slots.borrowed_tokens, uploads)
        # After the new login the read finds the receipt: failed with the module's own answer, never Eneo's, so the
        # page says the file was not sent and lets the person send it again.
        again = await self.client.get(self.path, headers=self.signed_in_again())
        self.assertEqual(again.status_code, 200, again.text)
        self.assertNotIn("x-auth-required", again.headers)
        self.assertEqual(again.json()["state"], "failed")
        self.assertEqual(again.json()["failure"], {"status": 401, "detail": "Not authenticated", "code": None})
        self.assertEqual(len(self.forwarded), 1, "nothing is forwarded again by itself")

    async def test_a_refusal_eneo_does_not_confirm_during_the_forward_keeps_the_session_and_eneos_failure(self):
        route = self.refused_by_eneo(confirmed=False)
        entry = await self.completed()
        self.release_forward.set()
        await asyncio.wait_for(asyncio.shield(entry.task), 1)

        status = await self.client.get(self.path)

        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.json()["failure"]["code"], "authentication_error", "Eneo's failure, as before")
        self.assertIsNotNone(main.module_auth.sessions.get(self.session_id))
        self.assertEqual(len(route.calls), 1)

    async def test_a_status_read_admitted_before_the_end_gets_the_session_answer_once_it_has_come(self):
        # The read is let in, then waits in the store's cleanup while the forward's refusal ends the session; it must
        # not hand the receipt over as if the login held, or the page would stop asking without a new login.
        self.refused_by_eneo(confirmed=True)
        entry = await self.completed()
        store = main.app.state.uploads
        expire, cleaning, go_on = store.expire, asyncio.Event(), asyncio.Event()

        async def held():
            cleaning.set()
            await go_on.wait()
            await expire()

        with patch.object(store, "expire", held):
            reading = asyncio.create_task(self.client.get(self.path))
            await asyncio.wait_for(cleaning.wait(), 1)
            self.release_forward.set()
            await asyncio.wait_for(asyncio.shield(entry.task), 1)
            self.assertEqual(entry.state, "failed", "the session ended inside the forward, before the receipt failed")
            self.assertIsNone(main.module_auth.sessions.get(self.session_id))
            go_on.set()
            response = await asyncio.wait_for(reading, 1)

        self.assert_session_answer(response)

    async def test_a_receipt_that_completes_while_the_session_ends_gives_its_file_after_the_new_login(self):
        entry = await self.completed()
        main.module_auth.sessions.delete(self.session_id)  # another call's refusal ended the login meanwhile
        self.release_forward.set()
        await asyncio.wait_for(asyncio.shield(entry.task), 1)

        self.assert_session_answer(await self.client.get(self.path))
        again = await self.client.get(self.path, headers=self.signed_in_again())
        self.assertEqual((again.status_code, again.json()["state"], again.json()["file_id"]), (200, "complete", "eneo-file"))

    async def test_a_login_eneo_ends_at_the_contract_read_keeps_the_whole_file_for_the_send_after_the_new_login(self):
        await self.create()
        await self.part(self.data, 0)
        contract = self.eneo.request

        async def refused(**kwargs):
            return httpx.Response(401, json=REVOKED)

        self.eneo.request, forward = refused, self.eneo.post
        route = self.refused_by_eneo(confirmed=True)
        self.eneo.post = forward

        self.assert_session_answer(await self.client.post(self.path + "/complete"))
        self.assertEqual(self.forwarded, [])
        self.assertEqual(len(route.calls), 1)

        self.eneo.request = contract
        new_login = self.signed_in_again()
        self.assertEqual((await self.client.get(self.path, headers=new_login)).json()["offset"], len(self.data), "the file is all there")
        self.release_forward.set()
        self.assertEqual((await self.client.post(self.path + "/complete", headers=new_login)).status_code, 200)
        (entry,) = main.app.state.uploads._entries.values()
        await asyncio.wait_for(asyncio.shield(entry.task), 1)
        status = (await self.client.get(self.path, headers=new_login)).json()
        self.assertEqual((status["state"], status["file_id"]), ("complete", "eneo-file"))
        self.assertEqual(len(self.forwarded), 1, "stored once")
