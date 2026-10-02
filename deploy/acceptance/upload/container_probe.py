#!/usr/bin/env python3
"""Runs INSIDE the container under test (the image has python): resident memory and CPU time of its processes, read from /proc.

    container_probe.py snapshot              one JSON line: [{pid, role, rss_kb, hwm_kb, cpu_ticks, args}]
    container_probe.py sample FILE MS        append {"t", "p": [...]} to FILE every MS ms until /tmp/upload-probe-stop exists

role is frontend (the Next server, whose process calls itself next-server), backend (uvicorn, or `python -m app.serve`) or
supervisord; anything else is named by its executable. The image's own health check (python -c ... urlopen) is left out.
"""
import json, os, sys, time

STOP = "/tmp/upload-probe-stop"


def role(args):
    if "next-server" in args or "server.js" in args:
        return "frontend"
    if "uvicorn" in args or "app.serve" in args:
        return "backend"
    if "supervisord" in args:
        return "supervisord"
    return args.split()[0].rsplit("/", 1)[-1]


def procs():
    out = []
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                args = f.read().replace(b"\0", b" ").decode(errors="replace").strip()
            status = dict(l.split(":", 1) for l in open(f"/proc/{pid}/status").read().splitlines() if ":" in l)
            stat = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
        except (FileNotFoundError, ProcessLookupError, PermissionError, IndexError):
            continue
        if int(pid) == os.getpid() or not args or "container_probe" in args or "urllib.request.urlopen" in args:
            continue
        out.append({"pid": int(pid), "role": role(args), "rss_kb": int(status["VmRSS"].split()[0]), "hwm_kb": int(status["VmHWM"].split()[0]),
                    "cpu_ticks": int(stat[11]) + int(stat[12]), "args": args[:90]})
    return out


if __name__ == "__main__":
    if sys.argv[1] == "snapshot":
        print(json.dumps(procs()))
    else:
        path, ms = sys.argv[2], int(sys.argv[3])
        if os.path.exists(STOP):
            os.remove(STOP)
        with open(path, "w") as f:
            while not os.path.exists(STOP):
                f.write(json.dumps({"t": time.time(), "p": procs()}) + "\n")
                f.flush()
                time.sleep(ms / 1000)
