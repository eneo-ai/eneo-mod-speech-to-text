#!/usr/bin/env python3
"""The live relay under static load: Task B4.2, check 15.

Static files, uploads and the WebSocket relay share one event loop in the image. One live session streams audio at 20 frames a second
and the round trip from a frame to the event the relay answers with is measured, first alone and then while the module is loaded.
Standard library only; the load runs in a process of its own, so that it does not take the measurement's time slices.

    live_load.py BASE_URL FLOW_ID STEP_ID EXPECTED_USER --cookie eneo_module_session=<id> [--origin URL] [--seconds 30] [--fps 20]
                 [--clients 200 | --rate 20] [--visit visit.json]

BASE_URL is the module as the browser reaches it (the Origin the page would send); --origin overrides it (a check against the image's own
port names the module's public address). The session is the one the cookie names, and the user the one it belongs to.

Two ways to load it, and what each is:

  --clients N   a stress test of the shell and its assets: N clients that each fetch the page and the files its HTML names (no
                script is run, so no lazy chunk, no font, no API call), over and over with no pause, so that the module is saturated.
  --rate R      an arrival rate: R visits a second, each a fresh connection and the requests of --visit in order, whatever the module
                is doing meanwhile (open loop). --visit is a JSON list of request paths: what a browser fetched on one cold visit
                (visit_resources.cjs records it). Without it a visit is the page and the files its HTML names, as above.

What is measured: the stub (the image's Eneo) answers a `transcript.delta` for every fourth binary frame it receives. The round trip is
the time from sending the fourth frame of a group to receiving that event. Every reply that is owed must come, within a bounded time
after the last frame: a reply that does not is counted as missing and the measurement fails (require_complete); an error event, or a
socket that closes before the replies are in, is an error. Nothing is left out of the percentiles silently.
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
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
FRAMES_PER_REPLY = 4  # the stub answers every fourth frame
TAIL_SECONDS = 5  # how long after the last frame the replies that are owed may take
REQUEST_DEADLINE = 15.0  # a connection, or one answer, of the load
MAX_IN_FLIGHT = 2000  # visits at once, at an arrival rate; one more is dropped and counted


class RelayError(Exception):
    """The relay sent an error event, or closed the socket before the replies were in."""


class Shortfall(Exception):
    """Replies that were owed did not come."""


@dataclasses.dataclass
class Trips:
    """What one measurement owed and what it got. ``seconds`` are the round trips of the replies that came."""

    expected: int
    seconds: list[float]

    @property
    def received(self) -> int:
        return len(self.seconds)

    @property
    def missing(self) -> int:
        return self.expected - self.received


def require_complete(*named: tuple[str, Trips]) -> None:
    """Raise Shortfall unless every reply that was owed came, in each of the measurements."""
    short = [f"{name}: {trips.missing} of {trips.expected} replies never came" for name, trips in named if trips.missing > 0 or trips.expected == 0]
    if short:
        raise Shortfall("; ".join(short))


def measure_round_trips(base: str, path: str, headers: dict[str, str], seconds: float, fps: int, *, tail_seconds: float = TAIL_SECONDS) -> Trips:
    """Stream silence at ``fps`` frames a second for ``seconds`` and wait, for at most ``tail_seconds`` after the last frame, for the
    reply to every fourth frame. Raises RelayError for an error event or a close before the replies are in."""
    ws = WebSocket(base, path, headers=headers)
    try:
        ready = ws.recv_json(timeout=10)
        if ready.get("type") != "ready":
            raise RelayError(f"the live socket's first event was {ready}, not ready")
        frame = bytes(FRAME_BYTES_PER_SECOND // fps)
        frames = int(seconds * fps)
        expected = frames // FRAMES_PER_REPLY
        sent_at: dict[int, float] = {}
        trips: list[float] = []
        failure: list[str] = []
        stop = threading.Event()

        def reader() -> None:
            deltas = 0
            while not stop.is_set():
                try:
                    _, payload = ws.recv(timeout=0.5)
                except TimeoutError:
                    continue
                except ConnectionEnded as ended:
                    if not stop.is_set():
                        failure.append(f"the relay closed the socket ({ws.close_code}) with {len(trips)} of {expected} replies in: {ended}")
                    return
                except Exception as error:  # a reader that dies must be heard of, not mistaken for a quiet relay
                    failure.append(f"reading the relay failed: {error!r}")
                    return
                received = time.perf_counter()
                event = json.loads(payload)
                if event.get("type") == "error":
                    failure.append(f"the relay sent an error event: {event}")
                    return
                if event.get("type") == "transcript.delta":
                    deltas += 1
                    started = sent_at.get(deltas * FRAMES_PER_REPLY)
                    if started is not None:
                        trips.append(received - started)

        thread = threading.Thread(target=reader, daemon=True)
        thread.start()
        try:
            begin = time.perf_counter()
            for number in range(1, frames + 1):
                due = begin + number * (1 / fps)
                while (wait := due - time.perf_counter()) > 0:
                    time.sleep(min(wait, 0.002))
                if failure:
                    break
                sent_at[number] = time.perf_counter()
                try:
                    ws.send_binary(frame)
                except OSError as error:
                    failure.append(f"sending frame {number} failed: {error!r}")
                    break
            deadline = time.monotonic() + tail_seconds
            while len(trips) < expected and not failure and time.monotonic() < deadline:
                time.sleep(0.01)
        finally:
            stop.set()
            thread.join(timeout=2)
        if failure:
            raise RelayError(failure[0])
        try:
            ws.send_text(json.dumps({"type": "stop"}))
        except OSError:
            pass
        return Trips(expected=expected, seconds=list(trips))
    finally:
        ws.abort()


def percentiles(trips: Trips) -> dict[str, float | int]:
    """The replies owed and received, and the percentiles of those that came (read them beside ``missing``)."""
    report: dict[str, float | int] = {"expected": trips.expected, "received": trips.received, "missing": trips.missing}
    ms = sorted(t * 1000 for t in trips.seconds)
    if ms:
        cut = lambda q: ms[min(len(ms) - 1, int(q * len(ms)))]
        report |= {"p50_ms": round(statistics.median(ms), 2), "p95_ms": round(cut(0.95), 2), "p99_ms": round(cut(0.99), 2), "max_ms": round(ms[-1], 2)}
    return report


# ---- the load: first-time visitors ------------------------------------------------------------------------------------
ASSET = re.compile(rb"""(?:src|href)=["'](/[^"']+)["']""")


def assets_named(html: bytes) -> list[str]:
    """The files a page's HTML names, as a browser would fetch them without running a script."""
    return sorted({m.decode() for m in ASSET.findall(html) if not m.startswith(b"//")})


async def fetch(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, host: str, path: str, cookie: str | None) -> tuple[int, int, bytes]:
    """One GET on an open connection, answered within REQUEST_DEADLINE; returns (status, bytes of body, body). No cache validators."""
    extra = f"Cookie: {cookie}\r\n" if cookie else ""
    writer.write(f"GET {path} HTTP/1.1\r\nHost: {host}\r\nAccept-Encoding: br, gzip\r\nAccept: */*\r\n{extra}\r\n".encode())

    async def exchange() -> tuple[int, int, bytes]:
        await writer.drain()
        head = await reader.readuntil(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        status = int(lines[0].split()[1])
        headers = {k.strip().lower(): v.strip() for k, _, v in (line.partition(":") for line in lines[1:] if line)}
        if "content-length" not in headers:
            raise ValueError(f"{path}: an answer with no Content-Length")
        body = await reader.readexactly(int(headers["content-length"]))
        return status, len(body), body

    return await asyncio.wait_for(exchange(), REQUEST_DEADLINE)


async def one_visit(host: str, port: int, visit: list[str] | None, cookie: str | None, totals: dict[str, int]) -> None:
    """A fresh connection, then the requests of a visit: the paths of ``visit``, or the page and the files its HTML names."""
    writer = None
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), REQUEST_DEADLINE)
        paths = list(visit) if visit is not None else ["/"]
        index = 0
        while index < len(paths):
            status, size, body = await fetch(reader, writer, f"{host}:{port}", paths[index], cookie)
            totals["requests"] += 1
            totals["bytes"] += size
            totals["errors"] += status != 200
            if visit is None and index == 0:
                paths += assets_named(body)
            index += 1
        totals["visits"] += 1
    except (OSError, asyncio.IncompleteReadError, ValueError, asyncio.TimeoutError):
        totals["errors"] += 1
        await asyncio.sleep(0.05)
    finally:
        if writer is not None:
            writer.close()


async def run_load(
    base: str, seconds: float, *, clients: int | None = None, rate: float | None = None, visit: list[str] | None = None, cookie: str | None = None
) -> dict[str, float | int]:
    """Load the module for ``seconds``: ``clients`` that visit over and over, or ``rate`` visits a second (open loop), each of ``visit``."""
    url = urlsplit(base)
    host, port = url.hostname, url.port or 80
    totals = {"requests": 0, "bytes": 0, "errors": 0, "visits": 0, "dropped": 0}
    until = time.monotonic() + seconds

    async def client() -> None:
        while time.monotonic() < until:
            await one_visit(host, port, visit, cookie, totals)

    if rate is None:
        await asyncio.gather(*(client() for _ in range(clients or 1)))
    else:
        running: set[asyncio.Task] = set()
        next_start = time.monotonic()
        while time.monotonic() < until:
            if len(running) >= MAX_IN_FLIGHT:
                totals["dropped"] += 1
            else:
                task = asyncio.create_task(one_visit(host, port, visit, cookie, totals))
                running.add(task)
                task.add_done_callback(running.discard)
            next_start += 1 / rate
            await asyncio.sleep(max(0.0, next_start - time.monotonic()))
        if running:
            _, stuck = await asyncio.wait(running, timeout=REQUEST_DEADLINE * 2)
            for task in stuck:
                task.cancel()
    shape = {"clients": clients} if rate is None else {"rate": rate}
    return {**totals, **shape, "seconds": seconds, "requests_per_second": round(totals["requests"] / seconds, 1), "mbit_per_second": round(totals["bytes"] * 8 / 1e6 / seconds, 1)}


def measure_under_load(base: str, path: str, headers: dict[str, str], seconds: float, fps: int, load_args: list[str]) -> tuple[Trips, dict]:
    """The round trips while the load runs in a process of its own; that process is ended and collected however this ends."""
    loader = subprocess.Popen(
        [sys.executable, __file__, base, "--load-only", "--seconds", str(seconds + TAIL_SECONDS + 2), *load_args], stdout=subprocess.PIPE, text=True
    )
    try:
        time.sleep(1)  # the load has started when the measurement does
        trips = measure_round_trips(base, path, headers, seconds, fps)
        output, _ = loader.communicate(timeout=seconds + TAIL_SECONDS + 2 + REQUEST_DEADLINE * 2 + 10)
        return trips, json.loads(output)
    finally:
        if loader.poll() is None:
            loader.terminate()
            try:
                loader.wait(timeout=5)
            except subprocess.TimeoutExpired:
                loader.kill()
                loader.wait()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("base_url")
    parser.add_argument("flow_id", nargs="?")
    parser.add_argument("step_id", nargs="?")
    parser.add_argument("expected_user", nargs="?")
    parser.add_argument("--cookie")
    parser.add_argument("--origin")
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--fps", type=int, default=20)
    parser.add_argument("--clients", type=int, help="the stress test: this many clients visit over and over (default 200)")
    parser.add_argument("--rate", type=float, help="the arrival rate: this many visits a second")
    parser.add_argument("--visit", help="a JSON list of the request paths of one visit")
    parser.add_argument("--load-only", action="store_true", help="run the load and print its totals (the measuring process starts this)")
    args = parser.parse_args()
    visit = json.loads(Path(args.visit).read_text()) if args.visit else None
    if args.load_only:
        print(json.dumps(asyncio.run(run_load(args.base_url, args.seconds, clients=args.clients or 200, rate=args.rate, visit=visit, cookie=args.cookie))))
        return
    path = f"/api/live/{args.flow_id}/{args.step_id}?expected_user={args.expected_user}&recording_id=acceptance-load"
    headers = {"Origin": args.origin or args.base_url, "Cookie": args.cookie}
    load_args = ["--rate", str(args.rate)] if args.rate else ["--clients", str(args.clients or 200)]
    load_args += (["--visit", args.visit] if args.visit else []) + (["--cookie", args.cookie] if args.cookie else [])
    idle = measure_round_trips(args.base_url, path, headers, args.seconds, args.fps)
    loaded, load = measure_under_load(args.base_url, path, headers, args.seconds, args.fps, load_args)
    print(json.dumps({"idle": percentiles(idle), "loaded": percentiles(loaded), "load": load}))
    require_complete(("idle", idle), ("loaded", loaded))


if __name__ == "__main__":
    main()
