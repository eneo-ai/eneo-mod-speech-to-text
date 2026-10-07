"""Process-local upload resources. Offsets commit whole parts; receipts outlive the spooled file."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import tempfile
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Literal
from uuid import UUID

import anyio
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.datastructures import Headers, UploadFile

CHUNK_BYTES = 4 * 1024 * 1024
MAX_RECEIPTS = 256
RECEIPT_SECONDS = 1800
logger = logging.getLogger("eneo_upload")


class UploadMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=255)
    size: int = Field(strict=True, gt=0)

    @field_validator("filename", "content_type")
    @classmethod
    def no_controls(cls, value: str) -> str:
        if any(c < " " or c == "\x7f" for c in value):
            raise ValueError("Control characters are not allowed")
        return value


class UploadFailure(BaseModel):
    status: int
    detail: str
    code: str | None = None


class UploadStatus(BaseModel):
    offset: int
    chunk_size: int
    state: Literal["receiving", "forwarding", "complete", "failed"]
    file_id: str | None = None
    failure: UploadFailure | None = None


@dataclass
class IncomingUpload:
    owner: tuple[str, str]
    flow_id: UUID
    step_id: UUID
    metadata: UploadMetadata
    expires_at: float
    idle_seconds: float
    idle_until: float
    chunk_size: int
    slots: contextlib.ExitStack
    file: UploadFile
    offset: int = 0
    state: Literal["receiving", "forwarding", "complete", "failed"] = "receiving"
    file_id: str | None = None
    failure: UploadFailure | None = None
    lock: anyio.Lock = field(default_factory=anyio.Lock)
    task: asyncio.Task[None] | None = None

    def touch(self) -> None:
        self.idle_until = time.monotonic() + self.idle_seconds

    def expired(self) -> bool:
        deadline = min(self.expires_at, self.idle_until) if self.state == "receiving" else self.expires_at
        return self.state != "forwarding" and deadline <= time.monotonic()

    @contextlib.contextmanager
    def exclusive(self):
        try:
            self.lock.acquire_nowait()
        except anyio.WouldBlock:
            raise HTTPException(503, "Another upload operation is running", headers={"Retry-After": "2"}) from None
        try:
            yield
        finally:
            self.lock.release()

    def status(self) -> UploadStatus:
        return UploadStatus(offset=self.offset, chunk_size=self.chunk_size, state=self.state,
                            file_id=self.file_id, failure=self.failure)

    async def release(self) -> None:
        with anyio.CancelScope(shield=True):
            try:
                await self.file.close()
            finally:
                self.slots.close()

    def start(self, forward: Callable[[], Awaitable[tuple[str | None, UploadFailure | None]]]) -> None:
        self.state = "forwarding"

        async def finish() -> None:
            try:
                self.file_id, self.failure = await forward()
                self.state = "complete" if self.file_id else "failed"
            except Exception as error:
                # A failure cannot leave an unobserved task or a permanently forwarding receipt.
                logger.error("Upload forwarding failed (%s)", type(error).__name__)
                self.failure = UploadFailure(status=502, detail="The upload result could not be confirmed.")
                self.state = "failed"
            finally:
                self.expires_at = time.monotonic() + RECEIPT_SECONDS
                await self.release()

        self.task = asyncio.create_task(finish(), name="resumable-upload-forward")


class UploadStore:
    def __init__(self) -> None:
        self._entries: dict[UUID, IncomingUpload] = {}

    async def remove(self, upload_id: UUID, entry: IncomingUpload) -> None:
        # Remove before awaiting cleanup so no caller can obtain a closing file.
        if self._entries.get(upload_id) is entry:
            del self._entries[upload_id]
            await entry.release()

    async def expire(self) -> None:
        for upload_id, entry in list(self._entries.items()):
            if not entry.expired():
                continue
            try:
                entry.lock.acquire_nowait()
            except anyio.WouldBlock:
                continue
            try:
                await self.remove(upload_id, entry)
            finally:
                entry.lock.release()

    async def sweep(self) -> None:
        while True:
            await asyncio.sleep(1)
            await self.expire()

    def find(self, upload_id: UUID, owner: tuple[str, str], flow_id: UUID, step_id: UUID,
             metadata: UploadMetadata | None = None) -> IncomingUpload | None:
        entry = self._entries.get(upload_id)
        if entry is None:
            return None
        if (entry.owner, entry.flow_id, entry.step_id) != (owner, flow_id, step_id):
            raise HTTPException(404, "Upload not found or expired")
        if metadata is not None and metadata != entry.metadata:
            raise HTTPException(409, "Upload metadata differs")
        entry.touch()
        return entry

    def get(self, upload_id: UUID, owner: tuple[str, str], flow_id: UUID, step_id: UUID) -> IncomingUpload:
        entry = self.find(upload_id, owner, flow_id, step_id)
        if entry is None:
            raise HTTPException(404, "Upload not found or expired")
        return entry

    def create(self, upload_id: UUID, owner: tuple[str, str], flow_id: UUID, step_id: UUID,
               metadata: UploadMetadata, lifetime: float, idle_seconds: float, chunk_size: int,
               slots: contextlib.ExitStack) -> IncomingUpload:
        if len(self._entries) >= MAX_RECEIPTS:
            finished = [(key, item) for key, item in self._entries.items() if item.task is not None and item.task.done()]
            if finished:
                oldest, _ = min(finished, key=lambda pair: pair[1].expires_at)
                del self._entries[oldest]
        if len(self._entries) >= MAX_RECEIPTS:
            raise HTTPException(503, "Upload receipt capacity reached", headers={"Retry-After": "2"})
        now = time.monotonic()
        entry = IncomingUpload(owner, flow_id, step_id, metadata, now + lifetime, idle_seconds, now + idle_seconds, chunk_size, slots,
            UploadFile(tempfile.TemporaryFile(), filename=metadata.filename,
                       headers=Headers({"content-type": metadata.content_type})))
        self._entries[upload_id] = entry
        return entry

    async def close(self) -> None:
        entries, self._entries = list(self._entries.values()), {}
        tasks = [entry.task for entry in entries if entry.task is not None]
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for entry in entries:
            await entry.release()
