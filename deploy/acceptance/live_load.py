#!/usr/bin/env python3
"""The live relay under static load: Task B4.2, check 15.

Static files, uploads and the WebSocket relay share one event loop in the image. One live session streams audio at 20 frames a second
and the round trip from a frame to the event the relay answers with is measured, first alone and then while many clients fetch the
page and its assets with nothing cached. Standard library only; the load runs in a process of its own, so that it does not take the
measurement's time slices.

    live_load.py BASE_URL FLOW_ID STEP_ID EXPECTED_USER --cookie eneo_module_session=<id> [--origin URL] [--seconds 30] [--clients 200] [--fps 20]

BASE_URL is the module as the browser reaches it (the Origin the page would send); --origin overrides it (a check against the image's own
port names the module's public address). The session is the one the cookie names, and the user the one it belongs to.

What is measured: the stub (the image's Eneo) answers a `transcript.delta` for every fourth binary frame it receives. The round trip is
the time from sending the fourth frame of a group to receiving that event. Prints one JSON object: for `idle` and `loaded` the number of
samples and the p50, p95, p99 and maximum in milliseconds, and for the load what it fetched. The verdict is the caller's: the plan stops
when the loaded p95 is more than twice the idle p95.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wsclient import ConnectionEnded, WebSocket  # noqa: E402

FRAME_BYTES_PER_SECOND = 32_000  # 16 kHz, 16-bit mono PCM


def measure_round_trips(base: str, path: str, headers: dict[str, str], seconds: float, fps: int) -> list[float]:
    """Stream silence at ``fps`` frames a second for ``seconds``; return the round trips, in seconds, of every fourth frame."""
    ws = WebSocket(base, path, headers=headers)
    ready = ws.recv_json(timeout=10)
    if ready.get("type") != "ready":
        raise RuntimeError(f"the live socket's first event was {ready}, not ready")
    frame = bytes(FRAME_BYTES_PER_SECOND // fps)
    sent_at: dict[int, float] = {}
    trips: list[float] = []
    stop = threading.Event()

    def reader() -> None:
        deltas = 0
        while not stop.is_set():
            try:
                _, payload = ws.recv(timeout=0.5)
            except TimeoutError:
                continue
            except ConnectionEnded:
                return
            received = time.perf_counter()
            if json.loads(payload).get("type") == "transcript.delta":
                deltas += 1
                started = sent_at.get(deltas * 4)
                if started is not None:
                    trips.append(received - started)

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    period = 1 / fps
    begin = time.perf_counter()
    for number in range(1, int(seconds * fps) + 1):
        due = begin + number * period
        while (wait := due - time.perf_counter()) > 0:
            time.sleep(min(wait, 0.002))
        sent_at[number] = time.perf_counter()
        ws.send_binary(frame)
    time.sleep(1)  # the last events
    stop.set()
    thread.join(timeout=2)
    ws.send_text(json.dumps({"type": "stop"}))
    ws.abort()
    return trips


def percentiles(trips: list[float]) -> dict[str, float | int]:
    ms = sorted(t * 1000 for t in trips)
    if not ms:
        return {"samples": 0}
    cut = lambda q: ms[min(len(ms) - 1, int(q * len(ms)))]
    return {"samples": len(ms), "p50_ms": round(statistics.median(ms), 2), "p95_ms": round(cut(0.95), 2), "p99_ms": round(cut(0.99), 2), "max_ms": round(ms[-1], 2)}


# ---- the load: first-time visitors ------------------------------------------------------------------------------------
ASSET = re.compile(rb"""(?:src|href)=["'](/[^"']+)["']""")


async def fetch(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, host: str, path: str) -> tuple[int, int, bytes]:
    """One GET on an open connection; returns (status, bytes of body, body). No cache validators, as a first visit sends."""
    writer.write(f"GET {path} HTTP/1.1\r\nHost: {host}\r\nAccept-Encoding: br, gzip\r\nAccept: */*\r\n\r\n".encode())
    await writer.drain()
    head = await reader.readuntil(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    status = int(lines[0].split()[1])
    headers = {k.strip().lower(): v.strip() for k, _, v in (line.partition(":") for line in lines[1:] if line)}
    if "content-length" in headers:
        body = await reader.readexactly(int(headers["content-length"]))
    else:
        raise ValueError(f"{path}: an answer with no Content-Length")
    return status, len(body), body


async def visitor(host: str, port: int, until: float, totals: dict[str, int]) -> None:
    """Visit the page again and again for as long as the load lasts: a fresh connection, the page, then each asset it names."""
    while time.monotonic() < until:
        try:
            reader, writer = await asyncio.open_connection(host, port)
            status, size, page = await fetch(reader, writer, f"{host}:{port}", "/")
            totals["requests"] += 1
            totals["bytes"] += size
            totals["errors"] += status != 200
            for asset in sorted({m.decode() for m in ASSET.findall(page) if not m.startswith(b"//")}):
                status, size, _ = await fetch(reader, writer, f"{host}:{port}", asset)
                totals["requests"] += 1
                totals["bytes"] += size
                totals["errors"] += status != 200
            writer.close()
        except (OSError, asyncio.IncompleteReadError, ValueError):
            totals["errors"] += 1
            await asyncio.sleep(0.05)


async def run_load(base: str, seconds: float, clients: int) -> dict[str, float | int]:
    url = urlsplit(base)
    totals = {"requests": 0, "bytes": 0, "errors": 0}
    until = time.monotonic() + seconds
    await asyncio.gather(*(visitor(url.hostname, url.port or 80, until, totals) for _ in range(clients)))
    return {**totals, "seconds": seconds, "clients": clients, "requests_per_second": round(totals["requests"] / seconds, 1), "mbit_per_second": round(totals["bytes"] * 8 / 1e6 / seconds, 1)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("base_url")
    parser.add_argument("flow_id", nargs="?")
    parser.add_argument("step_id", nargs="?")
    parser.add_argument("expected_user", nargs="?")
    parser.add_argument("--cookie")
    parser.add_argument("--origin")
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--clients", type=int, default=200)
    parser.add_argument("--fps", type=int, default=20)
    parser.add_argument("--load-only", action="store_true", help="run the visitors and print their totals (the measuring process starts this)")
    args = parser.parse_args()
    if args.load_only:
        print(json.dumps(asyncio.run(run_load(args.base_url, args.seconds, args.clients))))
        return
    path = f"/api/live/{args.flow_id}/{args.step_id}?expected_user={args.expected_user}&recording_id=acceptance-load"
    headers = {"Origin": args.origin or args.base_url, "Cookie": args.cookie}
    idle = measure_round_trips(args.base_url, path, headers, args.seconds, args.fps)
    loader = subprocess.Popen(
        [sys.executable, __file__, args.base_url, "--load-only", "--seconds", str(args.seconds + 2), "--clients", str(args.clients)],
        stdout=subprocess.PIPE, text=True,
    )
    time.sleep(1)  # the burst has started when the measurement does
    loaded = measure_round_trips(args.base_url, path, headers, args.seconds, args.fps)
    load = json.loads(loader.communicate(timeout=args.seconds + 60)[0])
    print(json.dumps({"idle": percentiles(idle), "loaded": percentiles(loaded), "load": load}))


if __name__ == "__main__":
    main()
