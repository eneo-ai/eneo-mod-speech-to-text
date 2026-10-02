#!/usr/bin/env python3
"""Memory of a running image under big multipart uploads: the method the baseline (B0.1) used and the acceptance (B4.2, check 9) repeats.

    measure.py CONTAINER BASE_URL ENEO_URL CASE [CASE ...]

    CASE        curl-<size>-<n>   n curl uploads at once, size one of 58MB, 300MB (300 MiB), 1GB (1 GiB), 2200MB (a sparse file)
                xhr-<size>        one XMLHttpRequest + FormData from a Blob in Chromium, as the app sends it (needs PW_DIR)
    CONTAINER   the running image; container_probe.py is copied into it and read its processes' resident memory every 100 ms
    BASE_URL    the image as the browser reaches it; it must be the image's MODULE_PUBLIC_URL, or the Origin check refuses the write
    ENEO_URL    the Eneo of the image: the SSO handshake runs against it, and it is the sink: GET /__log lists what it received
                (upstream.py's record format: request_line, content_length, transfer_encoding, bytes_received, how, seconds,
                started_at, finished_at) and GET /__reset clears the list

Environment: PW_DIR (a frontend directory with node_modules, for xhr cases), UPLOAD_PATH (default
/api/eneo/flows/flow-1/steps/step-1/runtime-files/), UPLOAD_FILES_DIR (default <tmp>/stt-upload-files), EXPECTED_USER (default user-1),
UPLOAD_ORIGIN (the Origin the write names; default BASE_URL: set it to the module's public address when BASE_URL is the image's own port).
Prints one JSON row per case. Start a fresh container per case for a clean "before"; the script stops nothing it did not start.
"""
import http.client, json, os, statistics, subprocess, sys, tempfile, time
from urllib.parse import quote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.environ.get("UPLOAD_PATH", "/api/eneo/flows/flow-1/steps/step-1/runtime-files/")
FILES = os.environ.get("UPLOAD_FILES_DIR", os.path.join(tempfile.gettempdir(), "stt-upload-files"))
USER = os.environ.get("EXPECTED_USER", "user-1")
ORIGIN = os.environ.get("UPLOAD_ORIGIN")
MB = 1_000_000
SIZES = {"58MB": 58 * MB, "300MB": 300 * 1024 * 1024, "1GB": 1024 * 1024 * 1024, "2200MB": 2_200_000_000}


def request(url, method="GET", headers=None):
    u = urlparse(url)
    c = http.client.HTTPConnection(u.hostname, u.port, timeout=60)
    c.request(method, u.path + ("?" + u.query if u.query else ""), headers=headers or {})
    r = c.getresponse()
    body = r.read()
    out = (r.status, {k.lower(): v for k, v in r.getheaders()}, body, r.msg.get_all("set-cookie") or [])
    c.close()
    return out


def sign_in(base, eneo):
    """The module's SSO handshake with the Eneo, redirects followed by hand. Returns the session cookie as name=value."""
    s, h, _, cookies = request(f"{base}/api/auth/login?next={quote('/flows')}")
    assert s == 303, (s, h)
    state_cookie = "; ".join(c.split(";")[0] for c in cookies)
    s, h, _, _ = request(h["location"])
    assert s == 303, (s, h)
    s, h, _, cookies = request(h["location"], headers={"Cookie": state_cookie})
    assert s == 303, (s, h)
    session = [c.split(";")[0] for c in cookies if c.startswith("eneo_module_session=")]
    assert session, (s, h, cookies)
    return session[0]


def docker(*args, **kw):
    return subprocess.run(["docker", *args], capture_output=True, text=True, **kw)


def make_file(name, size):
    os.makedirs(FILES, exist_ok=True)
    path = os.path.join(FILES, f"upload-{name}.bin")
    if not os.path.exists(path) or os.path.getsize(path) != size:
        with open(path, "wb") as f:
            if size > 1_500_000_000:  # a sparse file reads as zeros all the same
                f.truncate(size)
                return path
            block = bytes(1024 * 1024)
            left = size
            while left > 0:
                f.write(block[: min(len(block), left)])
                left -= len(block)
    return path


def start_probe(container):
    docker("cp", os.path.join(HERE, "container_probe.py"), f"{container}:/tmp/container_probe.py")
    docker("exec", container, "rm", "-f", "/tmp/upload-probe-stop", "/tmp/upload-probe.jsonl")
    docker("exec", "-d", container, "python", "/tmp/container_probe.py", "sample", "/tmp/upload-probe.jsonl", "100")
    time.sleep(0.5)


def stop_probe(container):
    docker("exec", container, "touch", "/tmp/upload-probe-stop")
    time.sleep(0.5)
    out = docker("exec", container, "cat", "/tmp/upload-probe.jsonl").stdout
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def by_role(sample):
    roles = {}
    for p in sample["p"]:
        roles[p["role"]] = roles.get(p["role"], 0) + p["rss_kb"]
    return roles


def run_case(container, base, eneo, label, commands):
    time.sleep(4)
    request(f"{eneo}/__reset")
    start_probe(container)
    time.sleep(2)  # the "before": samples taken while nothing is sent
    t0 = time.time()
    procs = [subprocess.Popen(c, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True) for c in commands]
    outs = [p.communicate()[0].strip().replace("\n", " ")[:160] for p in procs]
    t1 = time.time()
    time.sleep(8)  # does the memory come back?
    samples = stop_probe(container)
    before = [by_role(s) for s in samples if s["t"] < t0]
    during = [(s["t"], by_role(s)) for s in samples if s["t"] >= t0]
    roles = sorted({r for s in samples for r in by_role(s)})
    memory = {}
    for role in roles:
        base_kb = statistics.median(b.get(role, 0) for b in before)
        peak_t, peak_kb = max(((t, r.get(role, 0)) for t, r in during), key=lambda x: x[1])
        after_kb = statistics.median(r.get(role, 0) for _, r in during[-5:])
        memory[role] = {"before_MB": round(base_kb / 1024), "peak_MB": round(peak_kb / 1024), "growth_MB": round((peak_kb - base_kb) / 1024),
                        "peak_at_s": round(peak_t - t0, 1), "after_8s_MB": round(after_kb / 1024), "retained_MB": round((after_kb - base_kb) / 1024)}
    log = [r for r in json.loads(request(f"{eneo}/__log")[2]) if r["started_at"] >= t0 - 1]
    row = {"case": label, "seconds": round(t1 - t0, 1), "client": outs, "memory": memory,
           "sink": [{k: r.get(k) for k in ("request_line", "content_length", "transfer_encoding", "expect", "bytes_received", "how", "seconds")} for r in log]}
    print(json.dumps(row, ensure_ascii=False), flush=True)
    return row


def main():
    container, base, eneo, cases = sys.argv[1], sys.argv[2].rstrip("/"), sys.argv[3].rstrip("/"), sys.argv[4:]
    for name in cases:
        cookie = sign_in(base, eneo)
        kind, *rest = name.split("-")
        if kind == "curl":
            size, n = rest
            f = make_file(size, SIZES[size])
            command = ["curl", "-sS", "--max-time", "240", "-o", "/dev/null", "-w", "http=%{http_code} sent=%{size_upload} time=%{time_total}s",
                       "-H", "Expect:", "-H", f"Cookie: {cookie}", "-H", f"Origin: {ORIGIN or base}", "-H", f"X-Expected-User: {USER}",
                       "-F", f"upload_file=@{f};filename=opptagning.webm;type=audio/webm", f"{base}{PATH}?case={name}"]
            run_case(container, base, eneo, name, [command for _ in range(int(n))])
        elif kind == "xhr":
            run_case(container, base, eneo, name, [["node", os.path.join(HERE, "xhr.cjs"), base, str(SIZES[rest[0]]), name, PATH]])
        else:
            sys.exit(f"unknown case {name}")


main()
