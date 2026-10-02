"""A WebSocket client for the acceptance checks: RFC 6455, standard library only, no subprotocol unless asked.

The module's browser socket (`/api/live/<flow>/<step>`) is a plain WebSocket: binary frames up (PCM), a text `stop`, JSON events
down. A check needs to send a frame of an exact size, set the `Origin` and `Cookie` a browser would, and read the close code
the server answers with, which a browser's WebSocket API hides in some cases and a library would split into frames. This sends
every message as one frame.

    ws = WebSocket("http://127.0.0.1:8480", "/api/live/<flow>/<step>?expected_user=u", headers={"Origin": "...", "Cookie": "..."})
    ws.send_binary(b"\\0" * 65536)
    event = ws.recv_json(timeout=5)
    ws.close_code     # set when the server closed: 1009 for a frame over its limit
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import struct
import time
from urllib.parse import urlsplit

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
TEXT, BINARY, CLOSE, PING, PONG = 0x1, 0x2, 0x8, 0x9, 0xA


class HandshakeRefused(Exception):
    """The server answered the upgrade request with something other than 101."""

    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        super().__init__(f"the WebSocket handshake was answered {status}")
        self.status, self.headers, self.body = status, headers, body


class ConnectionEnded(Exception):
    """The socket closed (a close frame, or the connection dropped) before the message that was waited for."""


class WebSocket:
    def __init__(self, base_url: str, path: str, *, headers: dict[str, str] | None = None, timeout: float = 10.0) -> None:
        url = urlsplit(base_url)
        self.sock = socket.create_connection((url.hostname, url.port or 80), timeout=timeout)
        self.buffer = b""
        self.close_code: int | None = None
        self.close_reason = ""
        key = base64.b64encode(os.urandom(16))
        request = {"Host": url.netloc, "Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Key": key.decode(), "Sec-WebSocket-Version": "13", **(headers or {})}
        self.sock.sendall(f"GET {path} HTTP/1.1\r\n".encode() + b"".join(f"{k}: {v}\r\n".encode() for k, v in request.items()) + b"\r\n")
        head = self._read_until(b"\r\n\r\n")
        status_line, *header_lines = head.decode("latin-1").split("\r\n")
        status = int(status_line.split()[1])
        response = {k.strip().lower(): v.strip() for k, _, v in (line.partition(":") for line in header_lines if line)}
        if status != 101:
            length = int(response.get("content-length", "0"))
            body = self._read_exactly(length) if length else b""
            self.sock.close()
            raise HandshakeRefused(status, response, body)
        expected = base64.b64encode(hashlib.sha1(key + GUID).digest()).decode()
        if response.get("sec-websocket-accept") != expected:
            self.sock.close()
            raise ConnectionEnded("the server's Sec-WebSocket-Accept does not match the key")

    # ---- reading --------------------------------------------------------------------------------------------------
    def _fill(self, deadline: float | None = None) -> None:
        if deadline is not None:
            self.sock.settimeout(max(0.001, deadline - time.monotonic()))
        try:
            data = self.sock.recv(65536)
        except (ConnectionResetError, BrokenPipeError):
            data = b""
        if not data:
            raise ConnectionEnded("the connection dropped")
        self.buffer += data

    def _read_until(self, marker: bytes) -> bytes:
        while marker not in self.buffer:
            self._fill()
        head, _, self.buffer = self.buffer.partition(marker)
        return head

    def _read_exactly(self, count: int) -> bytes:
        while len(self.buffer) < count:
            self._fill()
        data, self.buffer = self.buffer[:count], self.buffer[count:]
        return data

    def _frame(self) -> tuple[int, bytes] | None:
        """One whole frame taken from the buffer, or None (the buffer is left as it was) while it is not all there."""
        buf = self.buffer
        if len(buf) < 2:
            return None
        opcode, length, offset = buf[0] & 0x0F, buf[1] & 0x7F, 2
        if length == 126:
            if len(buf) < 4:
                return None
            (length,), offset = struct.unpack(">H", buf[2:4]), 4
        elif length == 127:
            if len(buf) < 10:
                return None
            (length,), offset = struct.unpack(">Q", buf[2:10]), 10
        mask = b""
        if buf[1] & 0x80:
            mask, offset = buf[offset : offset + 4], offset + 4
            if len(mask) < 4:
                return None
        if len(buf) < offset + length:
            return None
        payload = buf[offset : offset + length]
        self.buffer = buf[offset + length :]
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return opcode, payload

    def recv(self, timeout: float = 10.0) -> tuple[int, bytes]:
        """The next text or binary message as (opcode, payload). A close frame sets close_code and raises ConnectionEnded;
        no message within ``timeout`` seconds raises TimeoutError (what was read stays buffered for the next call)."""
        deadline = time.monotonic() + timeout
        while True:
            frame = self._frame()
            if frame is None:
                try:
                    self._fill(deadline)
                except socket.timeout:
                    raise TimeoutError(f"no message within {timeout} s") from None
                continue
            opcode, payload = frame
            if opcode == CLOSE:
                self.close_code = struct.unpack(">H", payload[:2])[0] if len(payload) >= 2 else 1005
                self.close_reason = payload[2:].decode(errors="replace")
                raise ConnectionEnded(f"closed with {self.close_code}")
            if opcode == PING:
                self._send(PONG, payload)
            elif opcode in (TEXT, BINARY):
                return opcode, payload

    def recv_json(self, timeout: float = 10.0) -> dict:
        opcode, payload = self.recv(timeout)
        return json.loads(payload)

    def wait_for_close(self, timeout: float = 10.0) -> int | None:
        """Read until the server closes; returns the close code (None if the connection dropped with no close frame)."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                self.recv(max(0.05, deadline - time.monotonic()))
            except ConnectionEnded:
                return self.close_code
            except TimeoutError:
                break
        raise TimeoutError(f"the server did not close the socket within {timeout} s")

    # ---- writing --------------------------------------------------------------------------------------------------
    def _send(self, opcode: int, payload: bytes) -> None:
        length = len(payload)
        head = bytes([0x80 | opcode])
        if length < 126:
            head += bytes([0x80 | length])
        elif length < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", length)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", length)
        mask = os.urandom(4)
        self.sock.settimeout(30)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def send_binary(self, payload: bytes) -> None:
        self._send(BINARY, payload)

    def send_text(self, text: str) -> None:
        self._send(TEXT, text.encode())

    def abort(self) -> None:
        """Drop the connection with no close frame, as a browser tab that is closed does."""
        self.sock.close()

