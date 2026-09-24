"""A stand-in for the module backend (and Eneo behind it) for the accessibility
gate: every screen of the app without Eneo. Dev and test only; never shipped.

    python3 tests/e2e/stub-server.py [port]   # default 8401

Runs the page can open with ?run=<id>:
  run-done      finished, a report, two files and a transcript with audio
  run-plain     finished, text only, no transcript
  run-failed    failed in step 2, retryable
  run-running   never ends, for the progress view
  run-review    paused for "who is who" (flow-2)
  run-review-text  paused for a text step's output to be checked
  run-corrected finished like run-done, its transcript corrected after the document
The paused run-review has a passage split off to a third speaker, and its
checkpoint keeps the naming step's own proposal (original_payload_json).
A run the page starts itself runs for two polls, then finishes like run-done.
An upload whose file name starts with "langsam" is answered after 6 s.
flow-3 refuses a new run as a newer published version (409); flow-4 needs
republishing (409 on the contract); any unknown flow is gone (404). The live
relay on /api/live/ answers a word per four audio frames.
"""

import base64
import hashlib
import io
import itertools
import json
import math
import struct
import sys
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8401
AUDIO_STEP_ID = "00000000-0000-0000-0000-00000000a001"
REVIEW_STEP_ID = "00000000-0000-0000-0000-00000000b002"

AUDIO_STEP = {
    "step_id": AUDIO_STEP_ID,
    "step_order": 1,
    "input_format": "audio",
    "required": True,
    "max_files": 10,
    "max_file_size_bytes": 200 * 1024 * 1024,
    "accepted_mimetypes": ["audio/webm", "audio/mpeg", "audio/wav", "audio/mp4", "audio/x-m4a", "audio/ogg"],
}
LIVE_ON = {"live": {"available": True, "reason": None}, "speaker_labels": {"selectable": True, "required": False, "default": False}}


def flow(fid, name, description, version, space, fields, **contract):
    return {
        "published": {"id": fid, "name": name, "description": description, "published_version": version},
        "space": space,
        "contract": {"flow_id": fid, "published_flow_version": version, "form_fields": fields,
                     "steps_requiring_input": [AUDIO_STEP], **contract},
    }


PARTICIPANTS = {"name": "deltagare", "label": "Deltagare", "type": "list", "required": False, "order": 1}
FLOWS = {f["published"]["id"]: f for f in [
    flow("flow-1", "Nämndmöte till rapport", "Transkriberar mötet och skapar en PDF-rapport med beslut och sammanfattning.",
         3, ("space-1", "Kommunledningskontoret"), [PARTICIPANTS], transcription=LIVE_ON,
         security_classification={"name": "Öppen information", "security_level": 1,
                                  "description": "Använd bara information som får lämnas ut till vem som helst."}),
    flow("flow-2", "Intervju till sammanfattning", "Sammanfattar en intervju med citat och teman.", 7,
         ("space-1", "Kommunledningskontoret"),
         [{"name": "intervjuperson", "label": "Intervjuperson", "type": "text", "required": True, "order": 1},
          {"name": "typ", "label": "Typ av intervju", "type": "select", "options": ["Medborgare", "Personal"], "required": False, "order": 2}],
         transcription={"live": {"available": False, "reason": "model_not_realtime"},
                        "speaker_labels": {"selectable": False, "required": True, "default": True}},
         steps_requiring_review=[{"step_id": REVIEW_STEP_ID, "step_order": 2, "review_mode": "edit", "output_type": "json",
                                  "output_contract": {"properties": {"speakers": {"items": {"properties": {
                                      "label": {"pattern": "^SPEAKER_\\d{2,}$"}}}}}}}]),
    flow("flow-3", "Samråd till protokoll", "Gör ett protokoll av ett samrådsmöte.", 2, ("space-2", "Socialtjänsten"),
         [PARTICIPANTS, {"name": "arende", "label": "Ärende", "type": "text", "required": True, "order": 2}],
         transcription=LIVE_ON),
    flow("flow-4", "Nämndmöte till strukturerat protokoll med beslut, reservationer och bilagor", "Behöver publiceras om.",
         5, ("space-2", "Socialtjänsten"), []),
]}


def tone(seconds, freq):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"".join(struct.pack("<h", int(4000 * math.sin(2 * math.pi * freq * n / 16000)))
                               for n in range(int(seconds * 16000))))
    return buf.getvalue()


AUDIO = {"file-a": tone(12, 330), "file-b": tone(8, 440)}
PDF = (b"%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj "
       b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")


def words(text, start, end):
    parts = text.split(" ")
    step = (end - start) / len(parts)
    return [{"word": w, "start": round(start + i * step, 3), "end": round(start + (i + 1) * step, 3)} for i, w in enumerate(parts)]


SEGMENTS = [
    (0, 0.0, 3.0, "SPEAKER_00", "Välkomna till kommunstyrelsens möte."),
    (0, 3.0, 6.5, "SPEAKER_01", "Första punkten gäller budgeten för nästa år."),
    (0, 6.5, 11.5, "SPEAKER_00", "Ramen höjs med två procent och förvaltningen återkommer i oktober."),
    (1, 0.0, 3.5, "SPEAKER_01", "Andra punkten är skolskjutsarna."),
    (1, 3.5, 7.5, "SPEAKER_00", "Nya turer börjar gälla efter höstlovet."),
]
SEGMENTS_HASH = hashlib.sha256(json.dumps(SEGMENTS, ensure_ascii=False).encode()).hexdigest()
TRANSCRIBE_STEP = {
    "id": "result-1", "step_id": AUDIO_STEP_ID, "step_order": 1, "status": "completed",
    "started_at": "2026-09-24T09:00:00Z", "finished_at": "2026-09-24T09:01:00Z",
    "input_payload_json": {"transcription": {"file_ids": ["file-a", "file-b"], "segments": [
        {"file_index": f, "start": a, "end": b, "speaker": sp, "text": t, "words": words(t, a, b)} for f, a, b, sp, t in SEGMENTS],
        "segments_hash": SEGMENTS_HASH}},
    "output_payload_json": {"text": "Transkript"},
}
REPORT_STEP = {"id": "result-2", "step_id": "s2", "step_order": 2, "status": "completed",
               "started_at": "2026-09-24T09:01:00Z", "finished_at": "2026-09-24T09:02:00Z",
               "input_payload_json": {}, "output_payload_json": {"text": "Rapport"}}
GRAPH = {
    "nodes": [
        {"id": AUDIO_STEP_ID, "label": "Transkribera", "type": "llm", "step_order": 1, "input_source": "flow_input",
         "input_type": "audio", "output_type": "text", "output_mode": None},
        {"id": "s2", "label": "Skriv rapporten", "type": "llm", "step_order": 2, "input_source": "previous_step",
         "input_type": "text", "output_type": "pdf", "output_mode": None},
    ],
    "edges": [{"source": "s2", "target": "out", "kind": "flow_output", "label": None}],
}
# flow-2 stops for the person after transcribing: its second step is the speaker review.
GRAPH_WITH_REVIEW = {**GRAPH, "nodes": [GRAPH["nodes"][0], dict(GRAPH["nodes"][1], id=REVIEW_STEP_ID, label="Talare",
                                                               output_type="json")]}
REPORT = ("## Protokoll\n\nKommunstyrelsen beslutade att **höja budgetramen** med två procent.\n\n"
          "- Förvaltningen återkommer i oktober.\n- Nya skolskjutsturer gäller efter höstlovet.")
FILES = [
    {"file_id": "art-pdf", "name": "Protokoll kommunstyrelsen 2026-09-24.pdf", "mimetype": "application/pdf", "size": len(PDF)},
    {"file_id": "art-docx", "name": "Protokoll kommunstyrelsen 2026-09-24.docx",
     "mimetype": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "size": 18_432},
]
DONE = {"status": "completed", "result": {"kind": "inline_text", "text": REPORT}, "result_files": FILES,
        "steps": [TRANSCRIBE_STEP, REPORT_STEP], "step_status": ["completed", "completed"]}
RUNS = {
    "run-done": DONE,
    "run-plain": {"status": "completed", "result": {"kind": "inline_text", "text": "Protokollet är klart."},
                  "steps": [dict(REPORT_STEP, step_id=AUDIO_STEP_ID, input_payload_json={})], "step_status": ["completed", "completed"]},
    "run-failed": {"status": "failed", "steps": [TRANSCRIBE_STEP], "step_status": ["completed", "failed"],
                   "error": {"code": "flow_step_failed", "retryable": True, "step_id": "s2", "step_order": 2,
                             "message": "Step 2 failed: the model provider returned 503 Service Unavailable."}},
    "run-running": {"status": "running", "steps": [], "step_status": ["completed", "running"]},
    # Still transcribing, with the speaker review ahead (flow-2).
    "run-before-review": {"status": "running", "steps": [], "step_status": ["running", None]},
    "run-review": {"status": "awaiting_review", "steps": [TRANSCRIBE_STEP], "step_status": ["completed", None]},
    "run-review-text": {"status": "awaiting_review", "steps": [TRANSCRIBE_STEP], "step_status": ["completed", None]},
    # Approved, and its resume did not go through: the saved names stand and the run only has to go on.
    "run-review-approved": {"status": "awaiting_review", "steps": [TRANSCRIBE_STEP], "step_status": ["completed", None]},
    "run-review-text-approved": {"status": "awaiting_review", "steps": [TRANSCRIBE_STEP], "step_status": ["completed", None]},
    "run-corrected": DONE,
}
SPLIT = "Ramen höjs med två procent"
CORRECTIONS = {
    # The reviewer gave the start of a passage to a speaker of its own, who then needs a name.
    "run-review": {"speaker_edits": [{"segment_index": 2, "char_start": 0, "char_end": len(SPLIT), "original": SPLIT,
                                      "original_speaker": "SPEAKER_00", "speaker": "SPEAKER_02", "decision": "confirmed"}]},
    # Saved after the document (finished 09:02), so the result offers to make it again.
    "run-corrected": {"occurrences": [{"segment_index": 4, "char_start": 0, "char_end": 3, "original": "Nya", "corrected": "Fler"}]},
}


def corrections(run_id):
    if run_id not in CORRECTIONS:
        return []
    return [{"flow_run_id": run_id, "step_id": AUDIO_STEP_ID, "schema_version": 3, "segments_hash": SEGMENTS_HASH,
             "occurrences": [], "speaker_edits": [], "revision": 1, "stale": False, "updated_at": "2026-09-24T09:30:00Z",
             **CORRECTIONS[run_id]}]
CHECKPOINT = {
    "id": "cp-1", "flow_id": "flow-2", "flow_run_id": "run-review", "step_id": REVIEW_STEP_ID, "step_order": 2,
    "attempt_no": 1, "schema_version": 1, "step_label": "Talare", "state": "awaiting_review", "revision": 1,
    "review_mode": "edit", "output_type": "json", "created_at": "2026-09-24T09:01:00Z", "updated_at": "2026-09-24T09:01:00Z",
    "expires_at": "2026-10-08T09:01:00Z",
    "current_payload_json": {
        "text": "\n".join(t for *_, t in SEGMENTS),
        "speaker_mapping": {
            "source_step_id": AUDIO_STEP_ID, "source_step_order": 1, "participants": ["Anna Berg", "Erik Lund"],
            "inventory": [{"label": "SPEAKER_00", "line_count": 3, "samples": [SEGMENTS[0][4]]},
                          {"label": "SPEAKER_01", "line_count": 2, "samples": [SEGMENTS[1][4]]}]},
        "structured": {"speakers": [
            {"label": "SPEAKER_00", "name": "Anna Berg", "confidence": "high", "evidence": "Hälsar välkommen."},
            {"label": "SPEAKER_01", "name": "Erik Lund", "confidence": "medium", "evidence": "Föredrar ärendena."}]},
    },
}
# What the naming step proposed, before anyone edited it: the naming dialog's evidence.
CHECKPOINT["original_payload_json"] = json.loads(json.dumps(CHECKPOINT["current_payload_json"]))
# A text step paused for review (run-review-text): its output can be edited before the flow goes on.
# Paused in December, its deadline falls in the next year.
TEXT_CHECKPOINT = {
    **{k: v for k, v in CHECKPOINT.items() if k not in ("current_payload_json", "original_payload_json")},
    "created_at": "2026-12-20T08:01:00Z", "updated_at": "2026-12-20T08:01:00Z", "expires_at": "2027-01-03T08:01:00Z",
    "id": "cp-2", "flow_id": "flow-1", "flow_run_id": "run-review-text", "step_id": "s2", "step_label": "Sammanfattning",
    "output_type": "text", "current_payload_json": {"text": "Kommunstyrelsen beslutade att höja budgetramen med två procent."},
}
APPROVED_CHECKPOINT = dict(CHECKPOINT, flow_run_id="run-review-approved", state="approved", revision=3,
                          approved_at="2026-09-24T09:05:00Z")
APPROVED_TEXT_CHECKPOINT = dict(TEXT_CHECKPOINT, flow_run_id="run-review-text-approved", state="approved", revision=3,
                               approved_at="2026-12-20T08:05:00Z")
PAUSES = {"run-review": CHECKPOINT, "run-review-text": TEXT_CHECKPOINT, "run-review-approved": APPROVED_CHECKPOINT,
          "run-review-text-approved": APPROVED_TEXT_CHECKPOINT}
# Runs started through the page: id -> status reads so far.
STARTED = {}
NEW_RUN = itertools.count(1)
LIVE_WORDS = ("Välkomna till kommunstyrelsens möte. Första punkten gäller budgeten för nästa år. "
              "Ramen höjs med två procent och förvaltningen återkommer med en plan i oktober.").split(" ")


def run_state(run_id, poll=False):
    """A started run counts its status polls: running for two, then done."""
    if run_id in STARTED:
        STARTED[run_id] += poll
        return DONE if STARTED[run_id] > 2 else RUNS["run-running"]
    return RUNS.get(run_id)


def ws_send(wfile, opcode, payload):
    n = len(payload)
    head = bytes([0x80 | opcode]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack(">H", n))
    wfile.write(head + payload)
    wfile.flush()


def ws_recv(rfile):
    head = rfile.read(2)
    if len(head) < 2:
        return None, None
    n = head[1] & 0x7F
    if n == 126:
        n = struct.unpack(">H", rfile.read(2))[0]
    elif n == 127:
        n = struct.unpack(">Q", rfile.read(8))[0]
    mask = rfile.read(4) if head[1] & 0x80 else b"\0\0\0\0"
    data = bytearray(rfile.read(n))
    for i in range(n):
        data[i] ^= mask[i % 4]
    return head[0] & 0x0F, bytes(data)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send(self, status, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def audio(self, data):
        start, end, status = 0, len(data) - 1, 200
        wanted = self.headers.get("Range", "")
        if wanted.startswith("bytes="):
            first, _, last = wanted[6:].partition("-")
            start, end, status = int(first or 0), min(int(last), len(data) - 1) if last else len(data) - 1, 206
        self.send_response(status)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
        self.end_headers()
        self.wfile.write(data[start:end + 1])

    def live(self):
        key = self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", base64.b64encode(hashlib.sha1(key.encode()).digest()).decode())
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True
        text = lambda obj: ws_send(self.wfile, 1, json.dumps(obj).encode())
        text({"type": "ready", "sample_rate": 16000, "max_seconds": 18000})
        said, frames = [], 0
        try:
            while True:
                opcode, data = ws_recv(self.rfile)
                if opcode is None:
                    return
                if opcode == 2:
                    frames += 1
                    if frames % 4 == 0:
                        said.append(LIVE_WORDS[len(said) % len(LIVE_WORDS)])
                        text({"type": "transcript.delta", "text": (" " if len(said) > 1 else "") + said[-1]})
                elif opcode == 1 and json.loads(data).get("type") == "stop":
                    text({"type": "transcript.done", "text": " ".join(said)})
                    ws_send(self.wfile, 8, struct.pack(">H", 1000))
                    return
                elif opcode == 8:
                    ws_send(self.wfile, 8, data[:2])
                    return
        except OSError:
            return

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path.rstrip("/") + "/"
        if path.startswith("/api/live/") and self.headers.get("Upgrade", "").lower() == "websocket":
            return self.live()
        if path == "/api/auth/status/":
            return self.send(200, {"authenticated": True, "auth_mode": "eneo_sso",
                                   "user": {"id": "user-1", "email": "erik.lund@sundsvall.se", "username": "Erik Lund"},
                                   "session_ends_in": 8 * 60 * 60})
        if path == "/api/branding/":
            return self.send(200, {"organization": {"name": "Sundsvalls kommun", "logo": "default", "dark_logo": False}})
        if path == "/api/config/":
            return self.send(200, {"flow_list": {"space_id": None}})
        if path == "/api/eneo/flows/":
            return self.send(200, {"has_more": False, "count": len(FLOWS), "items": [
                {**f["published"], "is_published": True, "space_id": f["space"][0], "space_name": f["space"][1],
                 "input_type": "audio"} for f in FLOWS.values()]})
        parts = path.strip("/").split("/")
        if len(parts) < 5 or parts[:3] != ["api", "eneo", "flows"]:
            return self.send(404, {"detail": "stub: " + path})
        fid, rest = parts[3], parts[4:]
        f = FLOWS.get(fid)
        if f is None:
            return self.send(404, {"code": "flow_not_found", "detail": "Flow not found."})
        if fid == "flow-4" and rest in (["published"], ["run-contract"]):
            return self.send(409, {"code": "flow_assistant_snapshot_republish_required", "eneo_error_code": 9000,
                                   "message": "Step 1 (Transkribera ljud): Assistant snapshot is missing or uses an "
                                              "unsupported schema_version. Republish the flow before running it."})
        if rest == ["published"]:
            return self.send(200, f["published"])
        if rest == ["run-contract"]:
            return self.send(200, f["contract"])
        if rest == ["graph"]:
            graph = GRAPH_WITH_REVIEW if fid == "flow-2" else GRAPH
            run = run_state(parse_qs(url.query).get("run_id", [""])[0])
            if run is None:
                return self.send(200, graph)
            return self.send(200, {**graph, "nodes": [dict(n, run_status=s) for n, s in zip(graph["nodes"], run["step_status"])]})
        if rest == ["runs"]:
            earlier = [] if fid != "flow-1" else [
                {"id": "run-done", "flow_id": fid, "status": "completed", "created_at": "2026-09-23T09:00:00Z"},
                {"id": "run-failed", "flow_id": fid, "status": "failed", "created_at": "2026-09-22T14:30:00Z"}]
            return self.send(200, {"items": earlier, "has_more": False, "count": len(earlier)})
        if len(rest) < 2 or rest[0] != "runs":
            return self.send(404, {"detail": "stub: " + path})
        run_id, what = rest[1], rest[2:]
        if len(what) == 3 and what[0] == "input-files" and what[2] == "audio" and what[1] in AUDIO:
            return self.audio(AUDIO[what[1]])
        if len(what) == 3 and what[0] == "artifacts" and what[2] == "content":
            return self.send(200, PDF, "application/pdf")
        run = run_state(run_id, poll=what == ["status"])
        if run is None:
            return self.send(404, {"code": "flow_run_not_found", "detail": "Run not found."})
        if what in ([], ["status"]):
            body = {"id": run_id, "flow_id": fid, "status": run["status"], "flow_version": f["published"]["published_version"],
                    "created_at": "2026-09-24T09:00:00Z", "revision": 1}
            if not what:
                # The details the run was started with, which the flow's page shows beside the run.
                body.update(finished_at="2026-09-24T09:02:00Z", result=run.get("result"),
                            result_files=run.get("result_files", []), error=run.get("error"),
                            input_payload_json={"deltagare": ["Anna Berg", "Erik Lund"]} if fid == "flow-1" else {})
            return self.send(200, body)
        if what == ["steps"]:
            return self.send(200, run["steps"])
        if what == ["review-checkpoints", "active"]:
            return self.send(200, PAUSES.get(run_id))
        if what == ["transcript-corrections"]:
            return self.send(200, corrections(run_id))
        return self.send(404, {"detail": "stub: " + path})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        parts = urlparse(self.path).path.strip("/").split("/")
        if parts[:2] == ["api", "auth"]:
            return self.send(200, {"ok": True})
        if len(parts) >= 5 and parts[:3] == ["api", "eneo", "flows"]:
            fid, rest = parts[3], parts[4:]
            if len(rest) == 3 and rest[0] == "steps" and rest[2] == "runtime-files":
                if b'filename="langsam' in body:
                    time.sleep(6)  # holds the sending view on screen long enough to look at it
                return self.send(201, {"id": "file-%d" % len(body), "filename": "upload"})
            if len(rest) == 5 and rest[0] == "runs" and rest[2] == "steps" and rest[4] == "transcript-regenerations":
                run_id = "run-new-%d" % next(NEW_RUN)
                STARTED[run_id] = 0
                return self.send(201, {"run": {"id": run_id, "flow_id": fid, "status": "queued", "revision": 1},
                                       "created": True, "source_run_id": rest[1], "correction_revision": 1,
                                       "first_regenerated_step_id": "s2"})
            # Approving and resuming a pause: answered from copies, so a parallel test still sees the pause as it was.
            if len(rest) == 5 and rest[0] == "runs" and rest[2] == "review-checkpoints" and rest[4] in ("approve", "resume"):
                checkpoint = dict(PAUSES[rest[1]], state="approved")
                if rest[4] == "approve":
                    return self.send(200, checkpoint)
                run_id = "run-new-%d" % next(NEW_RUN)
                STARTED[run_id] = 0
                return self.send(200, {"checkpoint": dict(checkpoint, state="resumed"),
                                       "run": {"id": run_id, "flow_id": fid, "status": "running", "revision": 2,
                                               "flow_version": FLOWS[fid]["published"]["published_version"]}})
            if rest == ["runs"]:
                if fid == "flow-3":
                    return self.send(409, {"code": "flow_run_stale_version", "detail": "The flow has a newer published version."})
                run_id = "run-new-%d" % next(NEW_RUN)
                STARTED[run_id] = 0
                return self.send(201, {"id": run_id, "flow_id": fid, "status": "queued",
                                       "flow_version": FLOWS[fid]["published"]["published_version"]})
        return self.send(404, {"detail": "stub: " + self.path})


    def do_PATCH(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        parts = urlparse(self.path).path.strip("/").split("/")
        # Saving a pause's edit (the names): the edited value comes back as the pause's own, one revision on.
        if len(parts) == 8 and parts[:3] == ["api", "eneo", "flows"] and parts[4] == "runs" and parts[6] == "review-checkpoints":
            checkpoint = PAUSES[parts[5]]
            if checkpoint["state"] != "awaiting_review":
                return self.send(409, {"code": "flow_review_not_active", "detail": "The review is no longer active."})
            payload = dict(checkpoint["current_payload_json"])
            if isinstance(body.get("edited_value"), dict):
                payload["structured"] = body["edited_value"]
            else:
                payload["text"] = body.get("edited_value")
            return self.send(200, dict(checkpoint, revision=checkpoint["revision"] + 1, current_payload_json=payload))
        return self.send(404, {"detail": "stub: " + self.path})


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
