#!/usr/bin/env python3
"""A tiny upstream for the upload measurement: accepts any request, drains the body in 64 KB reads, records what it saw,
answers 200. GET /__log returns the records, GET /__reset clears them.

UPSTREAM_PORT (default 8456) and UPSTREAM_HOST (default 127.0.0.1) say where it listens. It is what stands behind a proxy under test when
nothing else should be there: the baseline put it on port 8000 inside the network namespace of a container that runs only the Next server."""
import json, os, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DELAY = float(os.environ.get("UPSTREAM_DELAY_MS", "0")) / 1000.0  # a slow backend: a pause after each 64 KB read
LOCK = threading.Lock()
LOG = []

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # silent
        pass

    def _drain(self):
        te = (self.headers.get("Transfer-Encoding") or "").lower()
        total = 0
        if "chunked" in te:
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    while self.rfile.readline() not in (b"\r\n", b"\n", b""):
                        pass
                    break
                left = size
                while left:
                    data = self.rfile.read(min(65536, left))
                    if not data:
                        return total, "eof inside a chunk"
                    left -= len(data); total += len(data)
                    if DELAY: time.sleep(DELAY)
                self.rfile.readline()
            return total, "chunked body complete"
        length = self.headers.get("Content-Length")
        if length is not None:
            left = int(length)
            while left:
                data = self.rfile.read(min(65536, left))
                if not data:
                    return total, "eof before Content-Length"
                left -= len(data); total += len(data)
                if DELAY: time.sleep(DELAY)
            return total, "Content-Length body complete"
        return 0, "no body framing"

    def _handle(self):
        if self.path.startswith("/__log"):
            body = json.dumps(LOG).encode()
        elif self.path.startswith("/__reset"):
            with LOCK:
                LOG.clear()
            body = b"{}"
        else:
            started = time.time()
            received, how = self._drain()
            finished = time.time()
            with LOCK:
                LOG.append({
                    "request_line": f"{self.command} {self.path} {self.request_version}",
                    "content_length": self.headers.get("Content-Length"),
                    "transfer_encoding": self.headers.get("Transfer-Encoding"),
                    "expect": self.headers.get("Expect"),
                    "content_type": (self.headers.get("Content-Type") or "")[:60],
                    "connection": self.headers.get("Connection"),
                    "bytes_received": received,
                    "how": how,
                    "seconds": round(time.time() - started, 2),
                    "started_at": started,
                    "finished_at": finished,
                })
            body = json.dumps({"id": "00000000-0000-0000-0000-000000000001", "name": "upstream", "size": received}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _handle

ThreadingHTTPServer.daemon_threads = True
ThreadingHTTPServer.request_queue_size = 64
PORT = int(os.environ.get("UPSTREAM_PORT", "8456"))
HOST = os.environ.get("UPSTREAM_HOST", "127.0.0.1")
print(f"upstream on {HOST}:{PORT}", flush=True)
ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
