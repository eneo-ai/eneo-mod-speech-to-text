#!/usr/bin/env python3
"""The acceptance of the production image: the 16 checks of Plan B, Task B4.2, on a running stack (deploy/acceptance/compose.yml).

    checks.py                run every check, one report, exit 1 if one failed
    checks.py --only 4,5,9   run these
    checks.py --list         say what each check proves

Standard library only; it drives docker, the image (directly and through Traefik), the stub that is the image's Eneo, and the
scripts of this folder (upload/measure.py, poll.cjs, auth-preload.cjs, loads.cjs, live_load.py). deploy/acceptance.sh builds and starts
the stack and then runs this. The stack is the one the environment names; the defaults are acceptance.sh's:

    ACCEPT_MODULE_URL    http://127.0.0.1:8480   the module as a browser reaches it: Traefik, and the image's MODULE_PUBLIC_URL
    ACCEPT_DIRECT_URL    http://127.0.0.1:8482   the image's own port
    ACCEPT_ENEO_URL      http://127.0.0.1:8481   the stub as Eneo: the sign-in handshake, /__log, /__reset and /__stub/stats
    ACCEPT_IMAGE         eneo-mod-speech-to-text:acceptance        ACCEPT_REVIEW_IMAGE   eneo-mod-speech-to-text:acceptance-review (built with SPEAKER_REVIEW_ENABLED=true)
    ACCEPT_CONTAINER     stt-acceptance-module                     ACCEPT_TRAEFIK_CONTAINER   stt-acceptance-traefik

A client that acts as the page names its user: X-Expected-User on a write, ?expected_user= on the live socket. Identifiers are those of
frontend/tests/fixtures/ids.json, which the stub serves; the headers are those of backend/app/security_headers.json; the numbers the
image is measured against are baseline.json (B0.1). Checks that stop or recreate the image leave it running when they end.

What the checks read of the stub (frontend/tests/e2e/stub-server.py, B3.1): GET /__stub/stats (file_streams_open, live_frames, live_bytes),
GET /__log and /__reset (upload/upstream.py's record format, one record per upload), and a file in ids.json under files.audioLarge that
never finishes by itself (a long WAV served in small pieces, with a pause), which checks 7, 10 and 16 hold open.
"""

from __future__ import annotations

import argparse
import dataclasses
import http.client
import json
import os
import re
import socket
import statistics
import struct
import subprocess
import sys
import tempfile
import time
import traceback
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import live_load  # noqa: E402
from wsclient import HandshakeRefused, WebSocket  # noqa: E402

IDS = json.loads((ROOT / "frontend/tests/fixtures/ids.json").read_text())
SECURITY_HEADERS = json.loads((ROOT / "backend/app/security_headers.json").read_text())
BASELINE = json.loads((HERE / "baseline.json").read_text())
REDIRECTS = {301, 302, 303, 307, 308}
MB = 1024 * 1024

FLOW, RUN_DONE, RUN_PDF, RUN_RUNNING = IDS["flows"]["flow1"], IDS["runs"]["done"], IDS["runs"]["pdf"], IDS["runs"]["running"]
AUDIO_STEP, AUDIO_FILE, PDF_FILE = IDS["steps"]["audio"], IDS["files"]["audioA"], IDS["files"]["pdf"]
AUDIO_LARGE = IDS["files"].get("audioLarge")
UPLOAD_PATH = f"/api/eneo/flows/{FLOW}/steps/{AUDIO_STEP}/runtime-files/"
# The speaker review's own text, in the part of an ASCII-escaped bundle before its first non-ASCII character: it is in dist/ only when
# the flag was on at build time (frontend/components/flow/ReviewView.tsx). B2 moves the code; the marker follows it.
SPEAKER_REVIEW_MARKER = os.environ.get("ACCEPT_SPEAKER_REVIEW_MARKER", "Lyssna, markera ord och v")
DEV_MARKERS = ("Grundkontroll", "/dev/foundation", "/dev/speaker-review", "/dev/dialog-leak")


class Failed(Exception):
    pass


def expect(condition: object, message: str) -> None:
    if not condition:
        raise Failed(message)


# ---- the stack ----------------------------------------------------------------------------------------------------------
@dataclasses.dataclass
class Stack:
    module: str = os.environ.get("ACCEPT_MODULE_URL", "http://127.0.0.1:8480")
    direct: str = os.environ.get("ACCEPT_DIRECT_URL", "http://127.0.0.1:8482")
    eneo: str = os.environ.get("ACCEPT_ENEO_URL", "http://127.0.0.1:8481")
    image: str = os.environ.get("ACCEPT_IMAGE", "eneo-mod-speech-to-text:acceptance")
    container: str = os.environ.get("ACCEPT_CONTAINER", "stt-acceptance-module")
    traefik: str = os.environ.get("ACCEPT_TRAEFIK_CONTAINER", "stt-acceptance-traefik")

    @property
    def review_image(self) -> str:
        return os.environ.get("ACCEPT_REVIEW_IMAGE", "eneo-mod-speech-to-text:acceptance-review")


STACK = Stack()


@dataclasses.dataclass
class Response:
    status: int
    headers: dict[str, str]
    body: bytes
    set_cookies: list[str]

    def json(self) -> object:
        return json.loads(self.body)

    def text(self) -> str:
        return self.body.decode(errors="replace")


def http_request(method: str, url: str, *, headers: dict[str, str] | None = None, body: bytes | None = None, timeout: float = 60) -> Response:
    parts = urlsplit(url)
    connection = http.client.HTTPConnection(parts.hostname, parts.port or 80, timeout=timeout)
    try:
        connection.request(method, parts.path + (f"?{parts.query}" if parts.query else ""), body=body, headers=headers or {})
        r = connection.getresponse()
        data = r.read()
        return Response(r.status, {k.lower(): v for k, v in r.getheaders()}, data, r.msg.get_all("set-cookie") or [])
    finally:
        connection.close()


def get(url: str, **kw: object) -> Response:
    return http_request("GET", url, **kw)  # type: ignore[arg-type]


def docker(*args: str, timeout: float = 600, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
    if check and result.returncode != 0:
        raise Failed(f"docker {' '.join(args[:3])} failed ({result.returncode}): {(result.stderr or result.stdout).strip()[:300]}")
    return result


def exec_in(container: str, *command: str) -> str:
    return docker("exec", container, *command).stdout.strip()


def wait_until(condition: Callable[[], bool], seconds: float, what: str, interval: float = 0.25) -> None:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return
        time.sleep(interval)
    raise Failed(f"{what}: not within {seconds:.0f} s")


def health_status() -> str:
    return docker("inspect", "-f", "{{.State.Health.Status}}", STACK.container, check=False).stdout.strip()


def direct_health_ok() -> bool:
    try:
        return get(f"{STACK.direct}/health", timeout=2).status == 200
    except OSError:
        return False


def wait_healthy(seconds: float = 120) -> None:
    wait_until(lambda: health_status() == "healthy" and direct_health_ok(), seconds, "the image is healthy")


def fresh_module(max_upload_bytes: int | None = None) -> None:
    """Recreate the image (a fresh process, no sessions, an empty /tmp), optionally with another MAX_UPLOAD_BYTES; wait until healthy."""
    env = dict(os.environ)
    if max_upload_bytes is not None:
        env["MAX_UPLOAD_BYTES"] = str(max_upload_bytes)
    else:
        env.pop("MAX_UPLOAD_BYTES", None)  # acceptance.env's
    result = subprocess.run(
        ["docker", "compose", "--env-file", str(HERE / "acceptance.env"), "-f", str(ROOT / "docker-compose.yml"), "-f", str(HERE / "compose.yml"), "-p", "stt-acceptance", "up", "-d", "--force-recreate", "--no-deps", "speech-to-text"],
        capture_output=True, text=True, env=env, timeout=300, cwd=ROOT,
    )
    if result.returncode != 0:
        raise Failed(f"could not recreate the image: {result.stderr.strip()[:300]}")
    wait_healthy()


@dataclasses.dataclass
class Session:
    cookie: str
    user: str

    def read(self) -> dict[str, str]:
        return {"Cookie": self.cookie}

    def write(self) -> dict[str, str]:
        """What the page sends with a request that changes something."""
        return {"Cookie": self.cookie, "Origin": STACK.module, "X-Expected-User": self.user}


def sign_in(base: str | None = None) -> Session:
    """The module's SSO handshake with the stub, redirects followed by hand (login -> Eneo -> callback), as a browser does."""
    base = base or STACK.module
    r = get(f"{base}/api/auth/login?next=/flows")
    expect(r.status == 303, f"GET /api/auth/login answered {r.status}, not 303")
    state_cookie = "; ".join(c.split(";")[0] for c in r.set_cookies)
    r = get(r.headers["location"])
    expect(r.status == 303, f"the stub's /module-login answered {r.status}, not 303")
    r = get(r.headers["location"], headers={"Cookie": state_cookie})
    expect(r.status == 303, f"GET /api/auth/callback answered {r.status}, not 303")
    session = [c.split(";")[0] for c in r.set_cookies if c.startswith("eneo_module_session=")]
    expect(session, "the callback set no session cookie")
    status = get(f"{base}/api/auth/status", headers={"Cookie": session[0]})
    user = status.json()["user"]["id"]  # type: ignore[index]
    return Session(session[0], user)


def stub_stats() -> dict[str, int]:
    r = get(f"{STACK.eneo}/__stub/stats")
    expect(r.status == 200, f"GET /__stub/stats answered {r.status}")
    stats = r.json()
    missing = {"file_streams_open", "live_frames", "live_bytes"} - set(stats)  # type: ignore[arg-type]
    expect(not missing, f"/__stub/stats lacks {sorted(missing)}")
    return stats  # type: ignore[return-value]


def open_stream(base: str, path: str, headers: dict[str, str], read_bytes: int = 65536) -> socket.socket:
    """GET on a raw socket, headers and the first ``read_bytes`` of the body read; the caller closes it (or leaves it open)."""
    parts = urlsplit(base)
    sock = socket.create_connection((parts.hostname, parts.port or 80), timeout=30)
    sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {parts.netloc}\r\n" + "".join(f"{k}: {v}\r\n" for k, v in headers.items()) + "\r\n").encode())
    data = b""
    while True:
        head, separator, body = data.partition(b"\r\n\r\n")
        if separator and len(body) >= read_bytes:
            break
        chunk = sock.recv(65536)
        if not chunk:
            raise Failed(f"the stream of {path} ended before {read_bytes} bytes of body")
        data += chunk
    expect(data.startswith((b"HTTP/1.1 200", b"HTTP/1.1 206")), f"the stream of {path} answered {data[:30]!r}")
    return sock


def reset(sock: socket.socket) -> None:
    """Close with a reset, as a browser tab that is closed in the middle of a download does."""
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
    sock.close()


def audio_path(file_id: str = AUDIO_FILE) -> str:
    return f"/api/eneo/flows/{FLOW}/runs/{RUN_DONE}/input-files/{file_id}/audio"


# ---- the pages and paths the first checks read -----------------------------------------------------------------------------
PAGES = ["/", "/flows", "/flows/", f"/flows/{FLOW}", f"/flows/{FLOW}?run={RUN_DONE}", "/inloggad", "/inloggad?fel=utgangen", "/inloggad?fel=annan-anvandare"]
# The reads the UI makes (frontend/lib/api.ts); the sign-in's own navigations (/api/auth/login and /callback) redirect by design.
API_READS = [
    "/api/auth/status", "/api/branding", "/api/branding/theme.css", "/api/config", "/api/eneo/flows/", f"/api/eneo/flows/{FLOW}/published/",
    f"/api/eneo/flows/{FLOW}/run-contract/", f"/api/eneo/flows/{FLOW}/graph/", f"/api/eneo/flows/{FLOW}/runs/", f"/api/eneo/flows/{FLOW}/runs/{RUN_DONE}/",
    f"/api/eneo/flows/{FLOW}/runs/{RUN_RUNNING}/status/", f"/api/eneo/flows/{FLOW}/runs/{RUN_DONE}/steps/",
    f"/api/eneo/flows/{FLOW}/runs/{RUN_DONE}/transcript-corrections/", f"/api/eneo/flows/{FLOW}/runs/{RUN_DONE}/review-checkpoints/active/",
]
UNKNOWN = ["/api/nope", "/api/auth/nope/deeper", "/assets/x.js", "/x.png", "/openapi.json", "/%00"]
_cache: dict[str, list[tuple[str, Response]]] = {}


def fetched_pages() -> list[tuple[str, Response]]:
    if "pages" not in _cache:
        session = sign_in()
        _cache["pages"] = [(p, get(STACK.direct + p)) for p in PAGES] + [(p, get(STACK.direct + p, headers=session.read())) for p in API_READS]
    return _cache["pages"]


def fetched_unknowns() -> list[tuple[str, Response]]:
    if "unknown" not in _cache:
        _cache["unknown"] = [(p, get(STACK.direct + p)) for p in UNKNOWN]
    return _cache["unknown"]


def is_html(r: Response) -> bool:
    return r.headers.get("content-type", "").startswith("text/html") or bool(re.search(rb"<!doctype html|<html", r.body[:2000], re.I))


# ---- the checks ------------------------------------------------------------------------------------------------------------
CHECKS: dict[int, tuple[str, Callable[[], str]]] = {}


def check(number: int, title: str) -> Callable[[Callable[[], str]], Callable[[], str]]:
    def register(function: Callable[[], str]) -> Callable[[], str]:
        CHECKS[number] = (title, function)
        return function

    return register


@check(1, "healthy: docker says so, and /health and /api/healthz answer {\"ok\": true} on 3001")
def check_1() -> str:
    expect(health_status() == "healthy", f"docker health is {health_status()!r}")
    for path in ("/health", "/api/healthz"):
        r = get(STACK.direct + path)
        expect(r.status == 200 and r.json() == {"ok": True}, f"GET {path} answered {r.status} {r.text()[:80]}")
    return "healthy; both routes answer {\"ok\": true}"


@check(2, "one process: one python, no node and no supervisord, and the user is not root")
def check_2() -> str:
    lines = docker("top", STACK.container).stdout.splitlines()
    header = lines[0].split()
    command_at, user_at = len(header) - 1, next(i for i, name in enumerate(header) if name in ("USER", "UID"))
    rows = [line.split(None, command_at) for line in lines[1:] if line.strip()]
    # The image's own health check starts a short-lived python beside the server.
    rows = [r for r in rows if "urllib.request.urlopen" not in r[command_at]]
    expect(len(rows) == 1, f"the container runs {len(rows)} processes: {[r[command_at][:60] for r in rows]}")
    command, user = rows[0][command_at], rows[0][user_at]
    expect("python" in command and "app.serve" in command, f"the process is {command[:80]!r}, not python -m app.serve")
    expect(user not in ("root", "0"), f"the process runs as {user}")
    found = exec_in(STACK.container, "sh", "-c", "command -v node; command -v supervisord; true")
    expect(found == "", f"the image holds {found!r}")
    uid = exec_in(STACK.container, "id", "-u")
    expect(uid != "0", "the container's user is root")
    return f"one process ({command[:50]}), user {user} (uid {uid}), no node, no supervisord"


@check(3, "every route of the app is the page, and no route or API path of the UI redirects")
def check_3() -> str:
    pages = fetched_pages()
    for path, r in pages[: len(PAGES)]:
        expect(r.status == 200 and r.headers.get("content-type", "").startswith("text/html"), f"GET {path} answered {r.status} {r.headers.get('content-type')}")
        expect("no-cache" in r.headers.get("cache-control", ""), f"GET {path}: Cache-Control is {r.headers.get('cache-control')!r}, not no-cache")
    for path, r in pages:
        expect(r.status not in REDIRECTS, f"GET {path} answered the redirect {r.status} to {r.headers.get('location')}")
    reads = pages[len(PAGES):]
    unreached = [p for p, r in reads if r.status >= 400]
    expect(not unreached, f"API reads that the stub should answer were refused: {unreached}")
    return f"{len(PAGES)} pages are 200 text/html no-cache; {len(PAGES) + len(reads)} requests, none a redirect"


@check(4, "an unknown /api path, a missing file, /openapi.json and a path with a NUL are 404 with no HTML body")
def check_4() -> str:
    for path, r in fetched_unknowns():
        expect(r.status == 404, f"GET {path} answered {r.status}, not 404")
        expect(not is_html(r), f"GET {path} answered HTML: {r.text()[:80]!r}")
    return f"{len(UNKNOWN)} paths, all 404, none HTML"


@check(5, "the headers of checks 3 and 4 are security_headers.json, and script and style allow nothing unsafe")
def check_5() -> str:
    seen = fetched_pages() + fetched_unknowns()
    for path, r in seen:
        for name, value in SECURITY_HEADERS.items():
            expect(r.headers.get(name.lower()) == value, f"GET {path}: {name} is {r.headers.get(name.lower())!r}, not {value!r}")
        policy = {d.split()[0]: d.split()[1:] for d in r.headers["content-security-policy"].split(";") if d.strip()}
        for directive in ("script-src", "style-src"):
            expect(not any(s.startswith("'unsafe-") for s in policy.get(directive, [])), f"GET {path}: {directive} allows {policy.get(directive)}")
    return f"{len(seen)} responses carry all {len(SECURITY_HEADERS)} headers with the file's values"


@check(6, "the shipped test:prod project, in Chromium, passes against the image")
def check_6() -> str:
    # The prod config also starts its other two backends, on dist/ and dist-check/, whichever project runs: both are built first.
    command = "npm run build && npm run build:check && npx playwright test --config playwright.prod.config.ts --project=shipped-chromium"
    env = {
        **os.environ,
        "PROD_EXTERNAL_URL": STACK.module,  # the shipped project's backend is the image behind Traefik ...
        "STUB_URL": STACK.eneo,  # ... and the stub that is its Eneo is the one upstream.spec.ts reads back
        "A11Y_APP_PORT": os.environ.get("A11Y_APP_PORT", "8487"),  # the config's own servers: 8487 to 8489, the stub of its own 8486
        "A11Y_STUB_PORT": os.environ.get("A11Y_STUB_PORT", "8486"),
    }
    r = subprocess.run(command, shell=True, cwd=ROOT / "frontend", env=env, capture_output=True, text=True, timeout=3600)
    tail = [line.strip() for line in (r.stdout + r.stderr).splitlines() if line.strip() and not line.startswith("[WebServer]")]
    failed = [line for line in tail if "✘" in line]
    expect(r.returncode == 0, f"`{command}` failed ({r.returncode}): {' | '.join(failed) or ' | '.join(tail[-4:])}; {tail[-1] if tail else ''}")
    passed = next((line for line in reversed(tail) if re.fullmatch(r"\d+ passed.*", line)), tail[-1] if tail else "ok")
    return f"shipped-chromium against {STACK.module}: {passed}"


@check(7, "Range on the audio route: 206 with Content-Range, a second range, 416, and a client that leaves leaves no upstream open")
def check_7() -> str:
    session = sign_in()
    path = audio_path()
    first = get(STACK.direct + path, headers={**session.read(), "Range": "bytes=0-99"})
    total = re.fullmatch(r"bytes 0-99/(\d+)", first.headers.get("content-range", ""))
    expect(first.status == 206 and total and len(first.body) == 100, f"bytes=0-99 answered {first.status} {first.headers.get('content-range')}")
    size = int(total.group(1))
    second = get(STACK.direct + path, headers={**session.read(), "Range": "bytes=100-199"})
    expect(second.status == 206 and second.headers.get("content-range") == f"bytes 100-199/{size}", f"bytes=100-199 answered {second.status} {second.headers.get('content-range')}")
    beyond = get(STACK.direct + path, headers={**session.read(), "Range": f"bytes={size + 1000}-"})
    expect(beyond.status == 416, f"a range past the end answered {beyond.status}, not 416")
    expect(AUDIO_LARGE, "ids.json has no files.audioLarge: nothing can be held open to leave half-way (B3.1's stub)")
    sock = open_stream(STACK.direct, audio_path(AUDIO_LARGE), {**session.read(), "Range": "bytes=0-"})
    wait_until(lambda: stub_stats()["file_streams_open"] >= 1, 10, "the stub sees the stream open")
    reset(sock)
    wait_until(lambda: stub_stats()["file_streams_open"] == 0, 10, "the upstream closes after the client leaves")
    return f"206 for two ranges of {size} bytes, 416 past the end; a stream left with a reset closed its upstream"


@check(8, "the live socket relays a 64 KiB frame, and a frame of 128 KiB + 1 closes it with 1009 before the stub sees it")
def check_8() -> str:
    session = sign_in()
    path = f"/api/live/{FLOW}/{AUDIO_STEP}?expected_user={session.user}&recording_id=acceptance-0001"
    ws = WebSocket(STACK.direct, path, headers={"Origin": STACK.module, "Cookie": session.cookie})
    try:
        expect(ws.recv_json(timeout=10).get("type") == "ready", "the first event was not ready")
        before = stub_stats()
        ws.send_binary(os.urandom(64 * 1024))
        wait_until(lambda: stub_stats()["live_frames"] == before["live_frames"] + 1, 10, "the stub receives the 64 KiB frame")
        after = stub_stats()
        expect(after["live_bytes"] - before["live_bytes"] == 64 * 1024, f"the stub received {after['live_bytes'] - before['live_bytes']} bytes of it")
        ws.send_header_only(128 * 1024 + 1)  # the limit is read from the header, before a byte of the frame
        code = ws.wait_for_close(10)
        expect(code == 1009, f"a frame of 128 KiB + 1 closed the socket with {code}, not 1009")
        time.sleep(1)
        final = stub_stats()
        expect(final["live_frames"] == after["live_frames"] and final["live_bytes"] == after["live_bytes"], "the stub received something of the oversize frame")
    finally:
        ws.abort()
    return "64 KiB relayed (+1 frame, +65536 bytes); 128 KiB + 1 closed with 1009 and the stub saw nothing of it"


def grew_mb(row: dict) -> tuple[int, int]:
    """What the upload cost in resident memory, of every process of the image together (the baseline's cost was in Next, beside the
    backend's): the growth of each process and the sum of their peaks."""
    memory = row["memory"].values()
    return sum(m["growth_MB"] for m in memory), sum(m["peak_MB"] for m in memory)


def measure(case: str, base: str, *, fresh: bool = True) -> dict:
    """upload/measure.py for one case, in a fresh container unless the image already runs as the check needs it; returns its row."""
    if fresh:
        fresh_module()
    env = {**os.environ, "UPLOAD_PATH": UPLOAD_PATH, "UPLOAD_ORIGIN": STACK.module, "EXPECTED_USER": sign_in(base).user}
    r = subprocess.run([sys.executable, str(HERE / "upload/measure.py"), STACK.container, base, STACK.eneo, case], capture_output=True, text=True, env=env, timeout=1800)
    rows = [line for line in r.stdout.splitlines() if line.startswith("{")]
    expect(r.returncode == 0 and rows, f"measure.py {case} failed: {(r.stderr or r.stdout).strip()[-300:]}")
    return json.loads(rows[-1])


def upload_row(case: str, base: str, file_bytes: int, files: int, growth_limit_mb: int) -> str:
    row = measure(case, base)
    client = row["client"]
    expect(all("http=201" in c for c in client), f"{case}: the client got {client}")
    got = [s["bytes_received"] for s in row["sink"]]
    expect(len(got) == files and all(file_bytes <= g <= file_bytes + 4096 for g in got), f"{case}: the stub received {got} bytes for {files} file(s) of {file_bytes}")
    grew, peak = grew_mb(row)
    expect(grew <= growth_limit_mb, f"{case}: the image's resident memory grew {grew} MB (limit {growth_limit_mb}), peak {peak}")
    return f"{case}: 201, the stub got every byte, memory +{grew} MB (peak {peak}, {row['seconds']} s)"


SIZES = {"300MB": 300 * MB, "1GB": 1024 * MB}


def over_cap(base: str, cap: int) -> str:
    """With a small MAX_UPLOAD_BYTES: a length declared over it is a 413 at once with max_upload_bytes in the answer, and an upload of
    three times the cap, sent in full by a client, costs no memory."""
    fresh_module(cap)
    session = sign_in(base)
    parts = urlsplit(base)
    connection = http.client.HTTPConnection(parts.hostname, parts.port or 80, timeout=30)
    connection.putrequest("POST", UPLOAD_PATH)
    for name, value in {**session.write(), "Content-Type": "multipart/form-data; boundary=x", "Content-Length": str(cap + 1)}.items():
        connection.putheader(name, value)
    connection.endheaders()
    connection.send(bytes(1024))  # the start of the body: the answer comes from the declared length
    r = connection.getresponse()
    body = r.read()
    connection.close()
    expect(r.status == 413 and json.loads(body).get("max_upload_bytes") == cap, f"a declared length over the cap answered {r.status} {body[:100]!r}")
    grew, _ = grew_mb(measure("curl-300MB-1", base, fresh=False))
    expect(grew <= 32, f"the refused upload grew the image's memory {grew} MB")
    return f"over the cap of {cap} bytes: 413 with max_upload_bytes at once for a declared length, and an upload of 300 MiB costs +{grew} MB"


def refused_every_time(base: str, cap: int, attempts: int = 20) -> str:
    """Uploads of three times the cap, sent in full by a client (curl): each must be answered 413. The module answers early and closes the
    connection while the client is still sending; behind a proxy that can come back as something else."""
    fresh_module(cap)
    session = sign_in(base)
    file = Path(tempfile.gettempdir()) / "stt-upload-files" / "upload-300MB.bin"
    file.parent.mkdir(exist_ok=True)
    if not file.exists() or file.stat().st_size != 300 * MB:
        file.write_bytes(bytes(300 * MB))
    answers: dict[str, int] = {}
    for _ in range(attempts):
        r = subprocess.run(
            ["curl", "-sS", "--max-time", "60", "-o", "/dev/null", "-w", "%{http_code}", "-H", "Expect:", "-H", f"Cookie: {session.cookie}", "-H", f"Origin: {STACK.module}",
             "-H", f"X-Expected-User: {session.user}", "-F", f"upload_file=@{file};filename=opptagning.webm;type=audio/webm", f"{base}{UPLOAD_PATH}"],
            capture_output=True, text=True,
        )
        key = r.stdout.strip() if r.stdout.strip() != "000" else f"000 ({r.stderr.strip()[:40]})"
        answers[key] = answers.get(key, 0) + 1
    expect(answers == {"413": attempts}, f"{attempts} uploads of 300 MiB over a cap of {cap} bytes were answered {answers}, not 413 every time")
    return f"{attempts} uploads of 300 MiB over a cap of {cap} bytes: 413 every time"


def abandoned(base: str) -> str:
    """An upload the client leaves half-way: the image stays healthy and holds no file descriptor or temp file for it."""
    fresh_module()
    session = sign_in(base)
    fds = lambda: int(exec_in(STACK.container, "sh", "-c", "ls /proc/1/fd | wc -l"))
    tmp = lambda: int(exec_in(STACK.container, "sh", "-c", "ls -A /tmp | wc -l"))
    before = (fds(), tmp())
    boundary = "acceptanceboundary"
    head = f'--{boundary}\r\nContent-Disposition: form-data; name="upload_file"; filename="opptagning.webm"\r\nContent-Type: audio/webm\r\n\r\n'.encode()
    total = len(head) + 300 * MB + len(f"\r\n--{boundary}--\r\n")
    parts = urlsplit(base)
    sock = socket.create_connection((parts.hostname, parts.port or 80), timeout=60)
    headers = {**session.write(), "Host": parts.netloc, "Content-Type": f"multipart/form-data; boundary={boundary}", "Content-Length": str(total)}
    sock.sendall((f"POST {UPLOAD_PATH} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in headers.items()) + "\r\n").encode() + head)
    chunk = bytes(MB)
    for _ in range(150):
        sock.sendall(chunk)
    reset(sock)
    wait_until(lambda: fds() <= before[0] and tmp() <= before[1], 20, "the image releases the abandoned upload's file descriptor and temp file")
    expect(get(f"{STACK.direct}/health").status == 200, "the image is not healthy after the abandoned upload")
    return f"a client that left after 150 of 300 MiB: file descriptors {before[0]} -> {fds()}, /tmp entries {before[1]} -> {tmp()}, still healthy"


@check(9, "upload memory: 300 MiB, 1 GiB and two at once cost the spool, not the file; over the cap is 413; a leaver leaves nothing")
def check_9() -> str:
    limit = 32
    lines = [
        upload_row("curl-300MB-1", STACK.direct, SIZES["300MB"], 1, limit),
        upload_row("curl-1GB-1", STACK.direct, SIZES["1GB"], 1, limit),
        upload_row("curl-300MB-2", STACK.direct, SIZES["300MB"], 2, 2 * limit),
        over_cap(STACK.direct, 100 * MB),
        abandoned(STACK.direct),
    ]
    up = BASELINE["uploads"]
    lines.append(f"baseline on Next (growth in MB): 300 MiB {up['curl_300MB']}, 1 GiB {up['curl_1GB']}, 2 x 300 MiB {up['curl_2x300MB']}; over 2 GiB: {up['over_2GiB']}")
    lines.append("path: /steps/<step>/runtime-files/, the baseline's, not the plan's .../files wording, so that the comparison is like for like")
    fresh_module()
    return "\n    ".join(lines)


@check(10, "docker stop with a file still streaming ends the container in under 10 s")
def check_10() -> str:
    expect(AUDIO_LARGE, "ids.json has no files.audioLarge: no stream stays open (B3.1's stub)")
    session = sign_in()
    sock = open_stream(STACK.direct, audio_path(AUDIO_LARGE), {**session.read(), "Range": "bytes=0-"})
    try:
        started = time.monotonic()
        docker("stop", STACK.container, timeout=60)
        took = time.monotonic() - started
        code = docker("inspect", "-f", "{{.State.ExitCode}}", STACK.container).stdout.strip()
    finally:
        sock.close()
        fresh_module()
    expect(took < 10 and code != "137", f"docker stop took {took:.1f} s and the exit code was {code} (137 is the kill after the grace period)")
    return f"stopped in {took:.1f} s, exit code {code}, with a stream open"


@check(11, "the inline PDF carries frame-ancestors 'self' and SAMEORIGIN")
def check_11() -> str:
    session = sign_in()
    r = get(f"{STACK.direct}/api/eneo/flows/{FLOW}/runs/{RUN_PDF}/artifacts/{PDF_FILE}/content?disposition=inline", headers=session.read())
    expect(r.status == 200 and r.headers.get("content-type", "").startswith("application/pdf"), f"the PDF route answered {r.status} {r.headers.get('content-type')}")
    expect(r.headers.get("x-frame-options") == "SAMEORIGIN", f"X-Frame-Options is {r.headers.get('x-frame-options')!r}")
    expect(r.headers.get("content-security-policy") == "frame-ancestors 'self'", f"Content-Security-Policy is {r.headers.get('content-security-policy')!r}")
    return "200 application/pdf, X-Frame-Options SAMEORIGIN, Content-Security-Policy frame-ancestors 'self' (the preview frame itself is in check 6: result-pdf-dialog)"


def grep_dist(image: str, pattern: str) -> list[str]:
    r = docker("run", "--rm", "--entrypoint", "sh", image, "-c", 'grep -rlF -- "$0" "$STATIC_DIR"; test $? -le 1', pattern, check=False)
    expect(r.returncode == 0, f"grep in {image} failed: {r.stderr.strip()[:200]}")
    return r.stdout.split()


@check(12, "a build with SPEAKER_REVIEW_ENABLED=true has the speaker review's text in dist/, the default image has not")
def check_12() -> str:
    on, off = grep_dist(STACK.review_image, SPEAKER_REVIEW_MARKER), grep_dist(STACK.image, SPEAKER_REVIEW_MARKER)
    expect(on, f"{STACK.review_image} (built with SPEAKER_REVIEW_ENABLED=true) does not contain {SPEAKER_REVIEW_MARKER!r}")
    expect(not off, f"the default image contains {SPEAKER_REVIEW_MARKER!r} in {off}")
    return f"{SPEAKER_REVIEW_MARKER!r} is in {len(on)} file(s) of the review build and in none of the default image's"


@check(13, "the default image's dist/ holds no Grundkontroll and no /dev/ route")
def check_13() -> str:
    found = {marker: grep_dist(STACK.image, marker) for marker in DEV_MARKERS}
    expect(not any(found.values()), f"the default image contains {({m: f for m, f in found.items() if f})}")
    return f"none of {list(DEV_MARKERS)} is in the default image (the browser's view of /dev/foundation is the routes spec of check 6)"


def probe(*args: str) -> str:
    docker("cp", str(HERE / "upload/container_probe.py"), f"{STACK.container}:/tmp/container_probe.py")
    return exec_in(STACK.container, "python", "/tmp/container_probe.py", *args)


def rss_by_role(snapshot: list[dict]) -> dict[str, float]:
    roles: dict[str, float] = {}
    for p in snapshot:
        roles[p["role"]] = roles.get(p["role"], 0) + p["rss_kb"] / 1024
    return roles


def node(script: str, *args: str, preload: bool = False, env: dict[str, str] | None = None, timeout: float = 900) -> str:
    pw = str(ROOT / "frontend")
    command = ["node", *(["-r", str(HERE / "auth-preload.cjs")] if preload else []), script, *args]
    r = subprocess.run(command, capture_output=True, text=True, cwd=ROOT, env={**os.environ, "PW_DIR": pw, "BASE_URL": STACK.module, **(env or {})}, timeout=timeout)
    expect(r.returncode == 0, f"{Path(script).name} failed: {(r.stderr or r.stdout).strip()[-300:]}")
    return r.stdout.strip()


@check(14, "the image against B0.1: size, start, idle and loaded memory, CPU under polling, page cost, layout shift")
def check_14() -> str:
    pw = str(ROOT / "frontend")
    out, problems = [], []
    size = int(docker("image", "inspect", "-f", "{{.Size}}", STACK.image).stdout)
    out.append(f"image size {size / 1e6:.0f} MB (baseline {BASELINE['image_bytes'] / 1e6:.0f} MB)")
    # start to healthy: a fresh container, timed from the command
    started = time.time()
    fresh_module()
    healthy_after = time.time() - started
    out.append(f"recreate to healthy {healthy_after:.1f} s (baseline docker healthy {BASELINE['start_seconds']['docker_healthy'][0]} s, first /health {BASELINE['start_seconds']['first_health_200'][0]} s)")
    time.sleep(40)
    idle = rss_by_role(json.loads(probe("snapshot")))
    idle_total = sum(idle.values())
    out.append(f"idle RSS {idle_total:.1f} MB {({k: round(v, 1) for k, v in idle.items()})} (baseline Next + uvicorn {BASELINE['idle_rss_mb']['frontend_and_backend']} MB, with supervisord {BASELINE['idle_rss_mb']['all']})")
    if idle_total > BASELINE["idle_rss_mb"]["frontend_and_backend"]:
        problems.append(f"idle memory {idle_total:.1f} MB is above the baseline's two processes, {BASELINE['idle_rss_mb']['frontend_and_backend']} MB")
    loaded_run = json.loads(node(str(HERE / "loads.cjs"), pw, STACK.module, "/flows", "20"))
    expect(loaded_run["ok"] == 20 and "/flows" in loaded_run["finalUrl"], f"loads.cjs: {loaded_run}")
    loaded = sum(rss_by_role(json.loads(probe("snapshot"))).values())
    out.append(f"RSS after /flows loaded 20 times {loaded:.1f} MB (baseline {BASELINE['loaded_rss_mb']['frontend_and_backend']} MB without supervisord)")
    if loaded > BASELINE["loaded_rss_mb"]["frontend_and_backend"]:
        problems.append(f"memory after 20 loads {loaded:.1f} MB is above the baseline's {BASELINE['loaded_rss_mb']['frontend_and_backend']} MB")
    # CPU and memory with 10 browsers polling a run, from the container's own samples over poll.cjs's window
    docker("exec", STACK.container, "rm", "-f", "/tmp/upload-probe-stop", "/tmp/poll.jsonl")
    docker("exec", "-d", STACK.container, "python", "/tmp/container_probe.py", "sample", "/tmp/poll.jsonl", "500")
    time.sleep(1)
    window = json.loads(node(str(HERE / "poll.cjs"), pw, STACK.module, "10", "60", RUN_RUNNING, FLOW))
    docker("exec", STACK.container, "touch", "/tmp/upload-probe-stop")
    time.sleep(1)
    samples = [json.loads(line) for line in exec_in(STACK.container, "cat", "/tmp/poll.jsonl").splitlines() if line.strip()]
    inside = [s for s in samples if window["from"] <= s["t"] <= window["to"]]
    expect(len(inside) > 20 and window["onRunPage"] == 10, f"poll.cjs: {window}, {len(inside)} samples inside the window")
    ticks = lambda s: sum(p["cpu_ticks"] for p in s["p"])
    cpu = (ticks(inside[-1]) - ticks(inside[0])) / 100 / (inside[-1]["t"] - inside[0]["t"]) * 100
    peak = max(sum(p["rss_kb"] for p in s["p"]) for s in inside) / 1024
    out.append(f"10 browsers polling ({window['pollsPerSecond']} polls/s): CPU {cpu:.1f} % of one core, RSS max {peak:.1f} MB (baseline CPU {BASELINE['polling']['cpu_percent']['all']} % with supervisord, RSS max {BASELINE['polling']['rss_mb']['all']['max']} MB)")
    if cpu > BASELINE["polling"]["cpu_percent"]["all"]:
        problems.append(f"CPU under polling {cpu:.1f} % is above the baseline's {BASELINE['polling']['cpu_percent']['all']} %")
    # what a page costs a visitor: page-cost.cjs, signed in, three runs, median
    paths = {"flows": "/flows", "flow": f"/flows/{FLOW}"}
    runs = [json.loads(node(str(ROOT / "docs/plans/page-cost.cjs"), pw, STACK.module, f"b42-{n}", *paths.values(), preload=True)) for n in (1, 2, 3)]
    for key, path in paths.items():
        base = BASELINE["pages"][key]
        for profile in ("desktop", "phone-4x-cpu"):
            rows = [r for run in runs for r in run["rows"] if r["path"] == path and r["profile"] == profile]
            med = lambda field: statistics.median(r[field] for r in rows)
            first_load = med("jsKB") + med("cssKB")
            wanted = (base["js_kb"] + base["css_kb"]) * 1.05
            ref = base["desktop" if profile == "desktop" else "phone_4x_cpu"]
            out.append(f"{path} {profile}: JS {med('jsKB'):g} + CSS {med('cssKB'):g} KB (baseline {base['js_kb']} + {base['css_kb']}), {med('requests'):g} requests (baseline {base['requests']}), LCP {med('lcp'):g} ms (baseline {ref['lcp_ms']}), TBT {med('tbt'):g} ms (baseline {ref['tbt_ms']}), CLS {med('cls'):g}")
            if first_load > wanted:
                problems.append(f"{path} {profile}: first-load JS+CSS {first_load:.1f} KB is more than 5 % above the baseline's {wanted / 1.05:.1f} KB")
            if med("cls") > 0.01:
                problems.append(f"{path} {profile}: layout shift {med('cls'):g} (the baseline has none: this is the evidence against decision D4, the organisation's mark written into the page)")
    out.append("LCP and TBT move with the machine's load: compare them against stt-before run in the same session; the sizes and counts above are the check")
    expect(not problems, "; ".join(problems) + "\n    " + "\n    ".join(out))
    return "\n    ".join(out)


RATES = (10, 45, 100)  # visits a second, for the arrival-rate envelope of check 15


@check(15, "the live relay under static load: the loaded p95 round trip is at most twice the idle p95")
def check_15() -> str:
    session = sign_in()
    path = f"/api/live/{FLOW}/{AUDIO_STEP}?expected_user={session.user}&recording_id=acceptance-load"
    headers = {"Origin": STACK.module, "Cookie": session.cookie}  # the load and the socket go to the image's own port: the browser's Origin, no Traefik
    lines, problems = [], []

    def relay(name: str, load_args: list[str]) -> tuple[dict, dict | None]:
        """The round trips while the load runs: what was owed and received, the percentiles, the load's own totals."""
        try:
            trips, load = live_load.measure_under_load(STACK.direct, path, headers, 30, 20, ["--cookie", session.cookie, *load_args])
        except live_load.RelayError as error:
            problems.append(f"{name}: {error}")
            return {}, None
        try:
            live_load.require_complete((name, trips))
        except live_load.Shortfall as error:
            problems.append(str(error))
        if load["errors"] or load["dropped"]:
            problems.append(f"{name}: the load had {load['errors']} errors and {load['dropped']} visits dropped in {load['requests']} requests")
        return live_load.percentiles(trips), load

    # what a browser fetches on one cold visit of a flow, and what the stress test below fetches of it
    requests = json.loads(node(str(HERE / "visit_resources.cjs"), STACK.module, f"/flows/{FLOW}"))["requests"]
    visit = [r["path"] for r in requests if r["method"] == "GET"]
    files = {r["path"] for r in requests if r["method"] == "GET" and r["type"] not in ("document", "fetch", "xhr")}
    stress_files = set(live_load.assets_named(get(STACK.direct + "/", headers={"Cookie": session.cookie}).body))
    by_type = {t: sum(r["type"] == t for r in requests) for t in sorted({r["type"] for r in requests})}
    lines.append(f"one cold visit of /flows/<id> in Chromium: {len(requests)} requests {by_type}; the stress test fetches the page and {len(stress_files)} files, {len(stress_files & files)} of them among the browser's {len(files)}; the browser also fetched {len(files - stress_files)} more files")
    if stress_files - files:
        problems.append(f"the stress test fetches files the browser does not on a visit: {sorted(stress_files - files)}")

    # the plan's measurement: 200 clients fetching the shell and its files over and over with no pause, against the idle relay
    try:
        idle_trips = live_load.measure_round_trips(STACK.direct, path, headers, 30, 20)
    except live_load.RelayError as error:
        raise Failed(f"idle: {error}")
    idle = live_load.percentiles(idle_trips)
    try:
        live_load.require_complete(("idle", idle_trips))
    except live_load.Shortfall as error:
        problems.append(str(error))
    stress, load = relay("stress, 200 clients", ["--clients", "200"])
    lines.append(f"idle: {idle}")
    if load:
        lines.append(f"stress test, shell and assets, 200 clients with no pause: {stress}; {load['requests_per_second']} requests/s, {load['mbit_per_second']} Mbit/s, {load['errors']} errors")
    if stress.get("p95_ms") is not None and idle.get("p95_ms") is not None and stress["p95_ms"] > 2 * idle["p95_ms"]:
        problems.append(f"the loaded p95 {stress['p95_ms']} ms is {stress['p95_ms'] / idle['p95_ms']:.1f} times the idle p95 {idle['p95_ms']} ms: the stop condition is more than twice")

    # an envelope, not a verdict: the visit above at a controlled arrival rate (open loop)
    with tempfile.NamedTemporaryFile("w", suffix=".json") as visit_file:
        json.dump(visit, visit_file)
        visit_file.flush()
        for rate in RATES:
            report, load = relay(f"{rate} visits/s", ["--rate", str(rate), "--visit", visit_file.name])
            if load:
                ratio = f", {report['p95_ms'] / idle['p95_ms']:.1f} times idle" if report.get("p95_ms") is not None and idle.get("p95_ms") else ""
                lines.append(f"arrival rate {rate} visits/s ({len(visit)} requests each): {report}{ratio}; {load['requests_per_second']} requests/s, {load['mbit_per_second']} Mbit/s, {load['errors']} errors, {load['dropped']} dropped")
    lines.append("one machine: the load generator, the relay's client and the image share the host's CPUs (a second host is not available)")
    detail = "\n    ".join(lines)
    expect(not problems, "; ".join(problems) + "\n    " + detail)
    return detail


@check(16, "through Traefik: the socket, the origin, uploads, Range, cookies, user_changed, a NUL path and docker stop")
def check_16() -> str:
    lines, problems = [], []
    lines.append(f"Traefik {docker('inspect', '-f', '{{.Config.Image}}', STACK.traefik).stdout.strip()}")
    session = sign_in(STACK.module)
    # the cookie the BFF sets reaches the client, and comes back
    login = get(f"{STACK.module}/api/auth/login?next=/flows")
    expect(any(c.startswith("eneo_module_login_state=") and "HttpOnly" in c for c in login.set_cookies), f"the login's Set-Cookie did not arrive through Traefik: {login.set_cookies}")
    status = get(f"{STACK.module}/api/auth/status", headers=session.read())
    expect(status.json()["authenticated"] is True, "the session cookie did not come back through Traefik")  # type: ignore[index]
    lines.append("the login's state cookie and the session cookie arrive and come back")
    # a write that names no user is a 409, as direct
    for base, name in ((STACK.module, "through Traefik"), (STACK.direct, "direct")):
        r = http_request("POST", f"{base}/api/eneo/flows/{FLOW}/runs/", headers={"Cookie": session.cookie, "Origin": STACK.module, "Content-Type": "application/json"}, body=b"{}")
        expect(r.status == 409 and r.json() == {"detail": "user_changed"}, f"a write naming no user {name} answered {r.status} {r.text()[:80]}")
    lines.append("a write that names no user is 409 user_changed, through Traefik and direct")
    # the socket upgrades and relays, and the browser's Origin reaches the check unchanged
    path = f"/api/live/{FLOW}/{AUDIO_STEP}?expected_user={session.user}&recording_id=acceptance-0016"
    ws = WebSocket(STACK.module, path, headers={"Origin": STACK.module, "Cookie": session.cookie})
    try:
        expect(ws.recv_json(timeout=10).get("type") == "ready", "no ready event through Traefik")
        before = stub_stats()
        ws.send_binary(os.urandom(64 * 1024))
        wait_until(lambda: stub_stats()["live_frames"] == before["live_frames"] + 1, 10, "the stub receives a frame relayed through Traefik")
    finally:
        ws.abort()
    try:
        WebSocket(STACK.module, path, headers={"Origin": "http://evil.example", "Cookie": session.cookie}).abort()
        raise Failed("a socket opened with another Origin was accepted through Traefik")
    except HandshakeRefused as refused:
        expect(refused.status in (403, 400), f"another Origin was answered {refused.status}")
    lines.append("the socket upgrades and relays a 64 KiB frame; another Origin is refused")
    # Range through Traefik equals direct
    for header in ("bytes=0-99", "bytes=100-199", "bytes=99999999999-"):
        a = get(STACK.module + audio_path(), headers={**session.read(), "Range": header})
        b = get(STACK.direct + audio_path(), headers={**session.read(), "Range": header})
        expect((a.status, a.headers.get("content-range"), a.body) == (b.status, b.headers.get("content-range"), b.body), f"Range {header}: Traefik {a.status} {a.headers.get('content-range')}, direct {b.status} {b.headers.get('content-range')}")
    lines.append("Range 206, 206 and 416 are the same through Traefik as direct")
    # a path with a NUL reaches the module as written, and its 404 comes back (check 4 has it direct)
    nul = get(f"{STACK.module}/%00")
    expect(nul.status == 404 and not is_html(nul), f"GET /%00 through Traefik answered {nul.status} {nul.text()[:60]!r}, not the module's 404 JSON")
    lines.append("a path with a NUL: the module's 404 JSON comes back through Traefik, as direct")
    # uploads through Traefik, as direct
    lines.append(upload_row("curl-300MB-1", STACK.module, SIZES["300MB"], 1, 32) + " (through Traefik)")
    lines.append(upload_row("curl-1GB-1", STACK.module, SIZES["1GB"], 1, 32) + " (through Traefik)")
    try:
        lines.append(refused_every_time(STACK.module, 100 * MB) + " (through Traefik)")
    except Failed as error:
        problems.append(str(error))  # the rest still runs: what else is proven through Traefik is part of the answer
    # docker stop with a stream open through Traefik
    fresh_module()
    expect(AUDIO_LARGE, "ids.json has no files.audioLarge: no stream stays open (B3.1's stub)")
    session = sign_in(STACK.module)
    sock = open_stream(STACK.module, audio_path(AUDIO_LARGE), {**session.read(), "Range": "bytes=0-"})
    try:
        started = time.monotonic()
        docker("stop", STACK.container, timeout=60)
        took = time.monotonic() - started
    finally:
        sock.close()
        fresh_module()
    expect(took < 10, f"docker stop with a stream open through Traefik took {took:.1f} s")
    lines.append(f"docker stop with a stream open through Traefik: {took:.1f} s")
    lines.append("not covered: TLS and the Secure cookie (a hand check at B6.1)")
    expect(not problems, "; ".join(problems) + "\n    " + "\n    ".join(lines))
    return "\n    ".join(lines)


# 10 stops the image and 16 stops it again; both leave a fresh one running. Everything else only reads or recreates it.
ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 10, 16]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", help="comma-separated check numbers")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()
    if args.list:
        for number in sorted(CHECKS):
            print(f"{number:>2}  {CHECKS[number][0]}")
        return 0
    wanted = [int(n) for n in args.only.split(",")] if args.only else ORDER
    image = docker("image", "inspect", "-f", "{{.Id}} {{.Size}}", STACK.image, check=False).stdout.split()
    print(f"image {STACK.image} {image[0][:19] if image else '(not found)'}  module {STACK.module}  direct {STACK.direct}  eneo {STACK.eneo}", flush=True)
    failed = []
    for number in [n for n in ORDER if n in wanted]:
        title, function = CHECKS[number]
        began = time.monotonic()
        try:
            detail = function()
            print(f"PASS {number:>2}  {title}\n    {detail}", flush=True)
        except Failed as error:
            failed.append(number)
            print(f"FAIL {number:>2}  {title}\n    {error}", flush=True)
        except Exception:  # a check that broke, not one that failed: show where
            failed.append(number)
            print(f"FAIL {number:>2}  {title}\n    {traceback.format_exc().strip()}", flush=True)
        print(f"        ({time.monotonic() - began:.1f} s)", flush=True)
    print(f"{len(wanted) - len(failed)} of {len(wanted)} checks passed" + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
