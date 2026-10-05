"""The one fake Eneo, and a stand-in for the module backend in front of it. Dev and test only; never shipped.

    python3 tests/e2e/stub-server.py [port]   # default 8401 (UPSTREAM_PORT, UPSTREAM_HOST)

It plays two roles in one process, told apart by path prefix, over one set of data (every flow, run and file exists once):

  the BFF (the module backend) for the accessibility gate's dev profile: /api/auth/*, /api/branding*,
      /api/eneo/*, /api/live/*, every screen of the app without Eneo and without a backend;
  Eneo for the real backend (python -m app.serve) and for the production-shaped tests: /api/v1/*, the module-login
      handshake, signed files with Range, the live ticket and an eneo-live.v1 socket, and a sink for uploads.

The Eneo role (MODULE_KEY and ENEO_API_KEY, the backend's own variables, say which module and key it knows):
  GET  /module-login?module_key&redirect_uri&state        sends the browser back with a one-time ticket and the state
  POST /api/v1/module-auth/token/                         the ticket, once, for a token (the service key)
  GET  /api/v1/module-auth/<key>/session/                 who the token is (both credentials)
  POST /api/v1/module-auth/<key>/token/refresh/           a new token (both credentials)
  /api/v1/<anything the BFF role serves under /api/eneo/> the same answer; the service key is required, and a bearer
                                                          token, when one is sent, must be one this stub gave
  POST /api/v1/flows/<f>/runs/<r>/{input-files,artifacts}/<file>/signed-url/   a signed URL on the stub
  GET  /api/v1/files/{audio,artifact}/<file>/download/    the file, with Range, 206, 416
  POST /api/v1/flows/<f>/steps/<s>/live-transcription-sessions/                a ticket and the socket's path
  GET  /api/v1/live-transcription                         the eneo-live.v1 socket, for a ticket the stub gave
  POST .../runtime-files/                                  an upload: drained in 64 KB reads, one record each

For tests (unauthenticated, never shipped): GET /__stub/stats, POST /__stub/reset, POST /__stub/end-session (every token
is refused from now on, as when Eneo ends the login) and, in upstream.py's format of deploy/acceptance/upload/ (so that
measure.py runs unchanged): GET /__log, GET /__reset. UPSTREAM_DELAY_MS pauses after each 64 KB read of an upload.

Identifiers (flows, steps, runs, files) are the UUIDs of tests/fixtures/ids.json, named there as below.
Runs the page can open with ?run=<id> (runs.<name>):
  done          finished, a report, two files and a transcript with audio
  plain         finished, text only, no transcript
  failed        failed in step 2, retryable
  running       never ends, for the progress view
  review        paused for "who is who" (flow2)
  reviewText    paused for a text step's output to be checked
  corrected     finished like done, its transcript corrected after the document
  pdf           finished, the document only its PDF, previewed from the step's text
  pdfLong       like pdf, a document long enough to fold
The paused review run has a passage split off to a third speaker, and its
checkpoint keeps the naming step's own proposal (original_payload_json).
A run the page starts itself runs for two polls, then finishes like done.
An upload whose file name starts with "langsam" is answered after 6 s; one
starting with "for-lang" is refused as longer than the flow takes.
flow3 refuses a new run as a newer published version (409); flow4 needs
republishing (409 on the contract); any unknown flow is gone (404). flow2
ends in text (Skapa text) and, labelling speakers, asks Antal talare; flows 1
and 3 ask it once Märk upp talare is on, filled from Deltagare, which their
contract names as the participants field. The live
relay on /api/live/ answers a word per four audio frames.
"""

import base64
import hashlib
import io
import itertools
import json
import math
import os
import re
import secrets
import struct
import sys
import threading
import time
import wave
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("UPSTREAM_PORT", "8401"))
HOST = os.environ.get("UPSTREAM_HOST", "127.0.0.1")
UPLOAD_DELAY = float(os.environ.get("UPSTREAM_DELAY_MS", "0")) / 1000.0  # a slow Eneo: a pause after each 64 KB read
# The Eneo role knows the module and the service key the real backend is started with, under the backend's own names.
MODULE_KEY = os.environ.get("MODULE_KEY", "speech-to-text")
SERVICE_KEY = os.environ.get("ENEO_API_KEY", "stub-service-key")
KEY_HEADER = os.environ.get("ENEO_API_KEY_HEADER_NAME", "X-API-Key")
USER = {"id": "user-1", "email": "erik.lund@sundsvall.se", "username": "Erik Lund"}
TENANT = "tenant-1"
TOKEN_SECONDS = int(os.environ.get("STUB_TOKEN_SECONDS", "900"))
SESSION_SECONDS = 8 * 60 * 60
LIVE_SUBPROTOCOL = "eneo-live.v1"
LIVE_PATH = "/api/v1/live-transcription"

# STUB_BRANDING is a deployment with an organisation of its own, for the gate's branding states
# (`npm run test:a11y:branding`): a long name and a green accent, with a wide logo for each colour mode ("custom") or
# without a logo, the name as text ("name"). The accent stylesheet is the backend's own (backend/app/accent.py), never
# a copy of it.
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "backend"))
from app.accent import resolve_accent, theme_css  # noqa: E402

BRANDING = os.environ.get("STUB_BRANDING")
CUSTOM_LOGO = BRANDING == "custom"
LOGOS = {name: (Path(__file__).resolve().parents[1] / "fixtures" / f"brand-wide-{name}.svg").read_bytes() for name in ("light", "dark")}


def logo_size(svg: bytes) -> dict:
    """What the backend reads from a logo at start (backend/app/config.py), for the fixtures' own viewBox."""
    width, height = re.search(rb'viewBox="0 0 (\d+) (\d+)"', svg).groups()
    return {"width": int(width), "height": int(height)}


ORGANIZATION = (
    {
        "name": "Förvaltningen för kultur, fritid och samhällsbyggnad i Västernorrlands län",
        "logo": "custom" if CUSTOM_LOGO else None,
        "dark_logo": CUSTOM_LOGO,
        "logo_sizes": {"light": logo_size(LOGOS["light"]), "dark": logo_size(LOGOS["dark"])} if CUSTOM_LOGO else None,
    }
    if BRANDING
    else {"name": "Sundsvalls kommun", "logo": "default", "dark_logo": False, "logo_sizes": None}
)
ACCENT = resolve_accent("#1E7B34", None) if BRANDING else None
# Every identifier the stub hands out is one of tests/fixtures/ids.json, which the gate's specs read too: the backend's live
# route takes UUIDs for the flow and the step, and Eneo's own ids are UUIDs.
IDS = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "ids.json").read_text())
F1, F2, F3, F4, F5 = (IDS["flows"][f"flow{n}"] for n in range(1, 6))
AUDIO_STEP_ID, REVIEW_STEP_ID, REPORT_STEP_ID = IDS["steps"]["audio"], IDS["steps"]["review"], IDS["steps"]["report"]
RUN, FILE, CHECKPOINT_ID, RESULT = IDS["runs"], IDS["files"], IDS["checkpoints"], IDS["results"]


def new_run_id(n):
    """The n-th run the page starts, a UUID of its own."""
    return f"00000000-0000-4000-9000-{n:012d}"


def new_file_id(n):
    return f"00000000-0000-4000-a000-{n:012d}"

AUDIO_STEP = {
    "step_id": AUDIO_STEP_ID,
    "step_order": 1,
    "input_format": "audio",
    "required": True,
    "max_files": 10,
    "max_file_size_bytes": 200 * 1024 * 1024,
    "accepted_mimetypes": ["audio/webm", "audio/mpeg", "audio/wav", "audio/mp4", "audio/x-m4a", "audio/ogg"],
}
LIVE_ON = {"live": {"available": True, "reason": None}, "speaker_labels": {"selectable": True, "required": False, "default": False},
           "max_speakers": {"form_field": None, "participants_field": "deltagare"}}


def flow(fid, name, description, version, space, fields, listed=True, **contract):
    return {
        "published": {"id": fid, "name": name, "description": description, "published_version": version},
        "space": space,
        # The flow list names the flows it shows; a flow that is not listed is only reached by its address.
        "listed": listed,
        "contract": {"flow_id": fid, "published_flow_version": version, "form_fields": fields,
                     "steps_requiring_input": [AUDIO_STEP], **contract},
    }


PARTICIPANTS = {"name": "deltagare", "label": "Deltagare", "type": "list", "required": False, "order": 1}
FLOWS = {f["published"]["id"]: f for f in [
    flow(F1, "Nämndmöte till rapport", "Transkriberar mötet och skapar en PDF-rapport med beslut och sammanfattning.",
         3, ("space-1", "Kommunledningskontoret"), [PARTICIPANTS], transcription=LIVE_ON,
         final_output={"step_id": REPORT_STEP_ID, "step_order": 2, "output_type": "pdf", "output_mode": "pass_through", "delivery": "artifact"},
         security_classification={"name": "Öppen information", "security_level": 1,
                                  "description": "Använd bara information som får lämnas ut till vem som helst."}),
    flow(F2, "Intervju till sammanfattning", "Sammanfattar en intervju med citat och teman.", 7,
         ("space-1", "Kommunledningskontoret"),
         [{"name": "intervjuperson", "label": "Intervjuperson", "type": "text", "required": True, "order": 1},
          {"name": "typ", "label": "Typ av intervju", "type": "select", "options": ["Medborgare", "Personal"], "required": False, "order": 2}],
         transcription={"live": {"available": False, "reason": "model_not_realtime"},
                        "speaker_labels": {"selectable": False, "required": True, "default": True},
                        "max_speakers": {"form_field": None, "participants_field": None}},
         final_output={"output_type": "text", "delivery": "payload"},
         steps_requiring_review=[{"step_id": REVIEW_STEP_ID, "step_order": 2, "review_mode": "edit", "output_type": "json",
                                  "output_contract": {"properties": {"speakers": {"items": {"properties": {
                                      "label": {"pattern": "^SPEAKER_\\d{2,}$"}}}}}}}]),
    # The flow asks the speaker count itself, as a number detail.
    flow(F3, "Samråd till protokoll", "Gör ett protokoll av ett samrådsmöte.", 2, ("space-2", "Socialtjänsten"),
         [PARTICIPANTS, {"name": "arende", "label": "Ärende", "type": "text", "required": True, "order": 2},
          {"name": "antal_talare", "label": "Antal talare", "type": "number", "required": False, "order": 3}],
         transcription={**LIVE_ON, "max_speakers": {"form_field": "antal_talare", "participants_field": "deltagare"}}),
    flow(F4, "Nämndmöte till strukturerat protokoll med beslut, reservationer och bilagor", "Behöver publiceras om.",
         5, ("space-2", "Socialtjänsten"), []),
    # A flow that asks a date (the lazy calendar of the details form), kept out of the list: no state of the list changes.
    flow(F5, "Nämndmöte med mötesdatum", "Frågar efter dagen mötet hölls.", 1, ("space-1", "Kommunledningskontoret"),
         [{"name": "motesdatum", "label": "Mötesdatum", "type": "date", "required": False, "order": 1}], listed=False),
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


class LargeWav:
    """files.audioLarge: 256 MiB of 16-bit silence as a WAV, made as it is read and never held. It goes out in 64 KiB pieces
    with a pause after each (about 6 MB/s), so a client that leaves half-way, and a server that stops with the stream open,
    have something to interrupt."""

    PIECE, PAUSE = 64 * 1024, 0.01

    def __init__(self, size):
        data = size - 44
        self.size = size
        self.head = (b"RIFF" + struct.pack("<I", size - 8) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16)
                     + b"data" + struct.pack("<I", data))

    def __len__(self):
        return self.size

    def pieces(self, start, stop):
        while start < stop:
            end = min(start + self.PIECE, stop)
            head = self.head[start:end]  # empty past the header
            yield head + bytes(end - start - len(head))
            start = end
            time.sleep(self.PAUSE)


def pieces(data, start, stop):
    """The bytes [start, stop) of a file: one piece for a file in memory, the pieces of a LargeWav as it makes them."""
    return data.pieces(start, stop) if isinstance(data, LargeWav) else [data[start:stop]]


AUDIO = {FILE["audioA"]: tone(12, 330), FILE["audioB"]: tone(8, 440), FILE["audioLarge"]: LargeWav(256 * 1024 * 1024)}
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
    "id": RESULT["transcribe"], "step_id": AUDIO_STEP_ID, "step_order": 1, "status": "completed",
    "started_at": "2026-09-24T09:00:00Z", "finished_at": "2026-09-24T09:01:00Z",
    "input_payload_json": {"transcription": {"file_ids": [FILE["audioA"], FILE["audioB"]], "segments": [
        {"file_index": f, "start": a, "end": b, "speaker": sp, "text": t, "words": words(t, a, b)} for f, a, b, sp, t in SEGMENTS],
        "segments_hash": SEGMENTS_HASH}},
    "output_payload_json": {"text": "Transkript"},
}
REPORT = ("## Protokoll\n\nKommunstyrelsen beslutade att **höja budgetramen** med två procent.\n\n"
          "- Förvaltningen återkommer i oktober.\n- Nya skolskjutsturer gäller efter höstlovet.")
REPORT_STEP = {"id": RESULT["report"], "step_id": REPORT_STEP_ID, "step_order": 2, "status": "completed",
               "started_at": "2026-09-24T09:01:00Z", "finished_at": "2026-09-24T09:02:00Z",
               "input_payload_json": {}, "output_payload_json": {"text": REPORT},
               "model_parameters_json": {"model_id": "model-1", "model_name": "Modell"}}
# A report with a table, as a model writes one in GitHub-flavoured Markdown: a header row, a right-aligned column, body cells.
TABLE_REPORT = ("## Beslut\n\nKommunstyrelsen fattade tre beslut.\n\n"
                "| Ärende | Beslut | Belopp, tkr |\n| --- | --- | ---: |\n"
                "| Budget 2027 | Ramen höjs | 1 200 |\n| Skolskjutsar | Nya turer | 450 |\n| Bredband | Utbyggnad norrut | 800 |\n\n"
                "Förvaltningen återkommer i oktober.")
GRAPH = {
    "nodes": [
        {"id": AUDIO_STEP_ID, "label": "Transkribera", "type": "llm", "step_order": 1, "input_source": "flow_input",
         "input_type": "audio", "output_type": "text", "output_mode": None},
        {"id": REPORT_STEP_ID, "label": "Skriv rapporten", "type": "llm", "step_order": 2, "input_source": "previous_step",
         "input_type": "text", "output_type": "pdf", "output_mode": None},
    ],
    "edges": [{"source": REPORT_STEP_ID, "target": "out", "kind": "flow_output", "label": None}],
}
# flow2 stops for the person after transcribing: its second step is the speaker review.
GRAPH_WITH_REVIEW = {**GRAPH, "nodes": [GRAPH["nodes"][0], dict(GRAPH["nodes"][1], id=REVIEW_STEP_ID, label="Talare",
                                                               output_type="json")]}
FILES = [
    {"file_id": FILE["pdf"], "name": "Protokoll kommunstyrelsen 2026-09-24.pdf", "mimetype": "application/pdf", "size": len(PDF),
     "step_id": REPORT_STEP_ID},
    {"file_id": FILE["docx"], "name": "Protokoll kommunstyrelsen 2026-09-24.docx",
     "mimetype": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "size": 18_432, "step_id": REPORT_STEP_ID},
]
# The report step's PDF and Word file are the run's result, as Eneo projects a final step's files.
DONE = {"status": "completed", "result": {"kind": "artifact", "files": FILES}, "result_files": FILES,
        "steps": [TRANSCRIBE_STEP, REPORT_STEP], "step_status": ["completed", "completed"]}
LONG_REPORT = REPORT + "".join(
    f"\n\n### {title}\n\n{body} Ärendet bereddes av förvaltningen och föredrogs av handläggaren. "
    "Ledamöterna ställde frågor om kostnaderna och om hur invånarna berörs. Beslutet justeras vid nästa sammanträde."
    for title, body in [("Budget 2027", "Ramen höjs med två procent."), ("Skolskjutsar", "Nya turer efter höstlovet."),
                        ("Äldreomsorg", "Två nya platser öppnar i vår."), ("Bredband", "Utbyggnaden fortsätter norrut."),
                        ("Övriga frågor", "Inga övriga frågor anmäldes.")])


def only_pdf(text):
    """A document that is only its PDF (Eneo's artifact result), made from the report step's text."""
    pdf = dict(FILES[0], step_id=REPORT_STEP_ID)
    return {"status": "completed", "result": {"kind": "artifact", "files": [pdf]}, "result_files": [pdf],
            # A model wrote the report: its parameters name the model, as Eneo records them.
            "steps": [TRANSCRIBE_STEP, dict(REPORT_STEP, output_payload_json={"text": text},
                                            model_parameters_json={"model_id": "model-1", "model_name": "Modell"})],
            "step_status": ["completed", "completed"]}


RUNS = {
    RUN["done"]: DONE,
    # Finished like done, its report with a table.
    RUN["table"]: dict(DONE, steps=[TRANSCRIBE_STEP, dict(REPORT_STEP, output_payload_json={"text": TABLE_REPORT})]),
    RUN["plain"]: {"status": "completed", "result": {"kind": "inline_text", "text": "Protokollet är klart."},
                  "steps": [dict(REPORT_STEP, step_id=AUDIO_STEP_ID, input_payload_json={})], "step_status": ["completed", "completed"]},
    RUN["failed"]: {"status": "failed", "steps": [TRANSCRIBE_STEP], "step_status": ["completed", "failed"],
                   "error": {"code": "flow_step_failed", "retryable": True, "step_id": REPORT_STEP_ID, "step_order": 2,
                             "message": "Step 2 failed: the model provider returned 503 Service Unavailable."}},
    RUN["running"]: {"status": "running", "steps": [], "step_status": ["completed", "running"]},
    # Still transcribing, with the speaker review ahead (flow2).
    RUN["beforeReview"]: {"status": "running", "steps": [], "step_status": ["running", None]},
    RUN["review"]: {"status": "awaiting_review", "steps": [TRANSCRIBE_STEP], "step_status": ["completed", None]},
    RUN["reviewText"]: {"status": "awaiting_review", "steps": [TRANSCRIBE_STEP], "step_status": ["completed", None]},
    # Approved, and its resume did not go through: the saved names stand and the run only has to go on.
    RUN["reviewApproved"]: {"status": "awaiting_review", "steps": [TRANSCRIBE_STEP], "step_status": ["completed", None]},
    RUN["reviewTextApproved"]: {"status": "awaiting_review", "steps": [TRANSCRIBE_STEP], "step_status": ["completed", None]},
    RUN["corrected"]: DONE,
    RUN["pdf"]: only_pdf(REPORT),
    RUN["pdfLong"]: only_pdf(LONG_REPORT),
}
SPLIT = "Ramen höjs med två procent"
CORRECTIONS = {
    # The reviewer gave the start of a passage to a speaker of its own, who then needs a name.
    RUN["review"]: {"speaker_edits": [{"segment_index": 2, "char_start": 0, "char_end": len(SPLIT), "original": SPLIT,
                                      "original_speaker": "SPEAKER_00", "speaker": "SPEAKER_02", "decision": "confirmed"}]},
    # Saved after the document (finished 09:02), so the result offers to make it again.
    RUN["corrected"]: {"occurrences": [{"segment_index": 4, "char_start": 0, "char_end": 3, "original": "Nya", "corrected": "Fler"}]},
}


def corrections(run_id):
    if run_id not in CORRECTIONS:
        return []
    return [{"flow_run_id": run_id, "step_id": AUDIO_STEP_ID, "schema_version": 3, "segments_hash": SEGMENTS_HASH,
             "occurrences": [], "speaker_edits": [], "revision": 1, "stale": False, "updated_at": "2026-09-24T09:30:00Z",
             **CORRECTIONS[run_id]}]
CHECKPOINT = {
    "id": CHECKPOINT_ID["review"], "flow_id": F2, "flow_run_id": RUN["review"], "step_id": REVIEW_STEP_ID, "step_order": 2,
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
# A text step paused for review (runs.reviewText): its output can be edited before the flow goes on.
# Paused in December, its deadline falls in the next year.
TEXT_CHECKPOINT = {
    **{k: v for k, v in CHECKPOINT.items() if k not in ("current_payload_json", "original_payload_json")},
    "created_at": "2026-12-20T08:01:00Z", "updated_at": "2026-12-20T08:01:00Z", "expires_at": "2027-01-03T08:01:00Z",
    "id": CHECKPOINT_ID["reviewText"], "flow_id": F1, "flow_run_id": RUN["reviewText"], "step_id": REPORT_STEP_ID, "step_label": "Sammanfattning",
    "output_type": "text", "current_payload_json": {"text": "Kommunstyrelsen beslutade att höja budgetramen med två procent."},
}
APPROVED_CHECKPOINT = dict(CHECKPOINT, flow_run_id=RUN["reviewApproved"], state="approved", revision=3,
                          approved_at="2026-09-24T09:05:00Z")
APPROVED_TEXT_CHECKPOINT = dict(TEXT_CHECKPOINT, flow_run_id=RUN["reviewTextApproved"], state="approved", revision=3,
                               approved_at="2026-12-20T08:05:00Z")
PAUSES = {RUN["review"]: CHECKPOINT, RUN["reviewText"]: TEXT_CHECKPOINT, RUN["reviewApproved"]: APPROVED_CHECKPOINT,
          RUN["reviewTextApproved"]: APPROVED_TEXT_CHECKPOINT}
# Runs started through the page: id -> status reads so far.
STARTED = {}
NEW_RUN = itertools.count(1)
LIVE_WORDS = ("Välkomna till kommunstyrelsens möte. Första punkten gäller budgeten för nästa år. "
              "Ramen höjs med två procent och förvaltningen återkommer med en plan i oktober.").split(" ")


class State:
    """What the Eneo role remembers: tickets, tokens, signed URLs, and what the tests read back from /__stub/stats."""

    def __init__(self):
        self.lock = threading.Lock()
        self.reset()
        self.login_tickets = {}  # ticket -> its deadline, until the token is asked for
        self.tokens = set()
        self.signatures = set()
        self.live_tickets = {}  # ticket -> the recording the page named when it asked, until the socket is opened

    def reset(self):
        with self.lock:
            self.log = []  # upstream.py's records, one per upload
            self.stats = {"file_streams_open": 0, "live_sockets_open": 0, "live_frames": 0, "live_bytes": 0, "live_tickets": 0,
                          "live_sessions": {}, "uploads": 0, "last_upload_bytes": 0}  # live_sessions: per recording, so specs can run side by side

    def count(self, name, by=1):
        with self.lock:
            self.stats[name] += by

    def new_token(self):
        token = secrets.token_urlsafe(24)
        self.tokens.add(token)
        ceiling = datetime.now(timezone.utc) + timedelta(seconds=SESSION_SECONDS)
        return {"access_token": token, "token_type": "bearer", "expires_in": TOKEN_SECONDS, "session_expires_at": ceiling.isoformat(),
                "module_key": MODULE_KEY, "tenant_id": TENANT, "user": USER}


STATE = State()


def run_state(run_id, poll=False):
    """A started run counts its status polls: running for two, then done."""
    if run_id in STARTED:
        STARTED[run_id] += poll
        return DONE if STARTED[run_id] > 2 else RUNS[RUN["running"]]
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


def is_upload(segments):
    """flows/<f>/steps/<s>/runtime-files, under /api/eneo or /api/v1."""
    rest = segments[4:]
    return (segments[:2] in (["api", "eneo"], ["api", "v1"]) and segments[2:3] == ["flows"] and len(segments) >= 5
            and len(rest) == 3 and rest[0] == "steps" and rest[2] == "runtime-files")


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

    def ranged(self, data, ctype, extra=None):
        """A file with Range semantics: 200 whole, 206 and Content-Range for a satisfiable range, 416 for one that is not.
        A Range that cannot be read is ignored, as the RFC says."""
        size, start, end, status = len(data), 0, len(data) - 1, 200
        wanted = self.headers.get("Range", "")
        if wanted.startswith("bytes=") and "," not in wanted:
            first, _, last = wanted[6:].partition("-")
            try:
                if first == "" and last != "":  # the last n bytes
                    start, end, status = max(size - int(last), 0), size - 1, 206
                elif first != "":
                    start, end, status = int(first), min(int(last), size - 1) if last else size - 1, 206
            except ValueError:
                start, end, status = 0, size - 1, 200
            if status == 206 and (start >= size or start > end or size == 0):
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Type", "application/json")
                body = json.dumps({"detail": "Range not satisfiable"}).encode()
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        STATE.count("file_streams_open")
        try:
            for piece in pieces(data, start, end + 1):
                self.wfile.write(piece)
        except OSError:
            self.close_connection = True  # the client left; a stream is left half-way on purpose
        finally:
            STATE.count("file_streams_open", -1)

    def audio(self, data):
        self.ranged(data, "audio/wav")

    def live(self, subprotocol=None, recording="", handshake=None):
        """The relay: ready, a word per four audio frames, the whole text at stop. As Eneo it speaks ``subprotocol``.
        What it receives is counted in total and under ``recording``, the id the page named."""
        key = self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", base64.b64encode(hashlib.sha1(key.encode()).digest()).decode())
        if subprotocol:
            self.send_header("Sec-WebSocket-Protocol", subprotocol)
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True
        text = lambda obj: ws_send(self.wfile, 1, json.dumps(obj).encode())
        text({"type": "ready", "sample_rate": 16000, "max_seconds": 18000})
        said, frames = [], 0
        with STATE.lock:
            seen = STATE.stats["live_sessions"][recording] = {"frames": 0, "bytes": 0, **(handshake or {})}
        STATE.count("live_sockets_open")
        try:
            while True:
                opcode, data = ws_recv(self.rfile)
                if opcode is None:
                    return
                if opcode == 2:
                    frames += 1
                    with STATE.lock:
                        STATE.stats["live_frames"] += 1
                        STATE.stats["live_bytes"] += len(data)
                        seen["frames"] += 1
                        seen["bytes"] += len(data)
                    if frames % 4 == 0:
                        said.append(LIVE_WORDS[len(said) % len(LIVE_WORDS)])
                        text({"type": "transcript.delta", "text": (" " if len(said) > 1 else "") + said[-1]})
                elif opcode == 1 and json.loads(data).get("type") == "stop":
                    text({"type": "transcript.done", "text": " ".join(said)})
                    ws_send(self.wfile, 8, struct.pack(">H", 1000))
                    return
                elif opcode == 9:  # a ping, as Eneo's server answers it: the backend's client closes a socket that does not pong in 20 s
                    ws_send(self.wfile, 10, data)
                elif opcode == 8:
                    ws_send(self.wfile, 8, data[:2])
                    return
        except OSError:
            return
        finally:
            STATE.count("live_sockets_open", -1)

    # ---- the Eneo role ----

    def refuse(self, why):
        if self.raw is None and self.command in ("POST", "PUT", "PATCH"):
            self.drain()  # an upload nobody took: its body must not be left for the next request on this connection
        self.send(401, {"detail": why})

    def credentialed(self, bearer_required=False):
        """The service key; and a bearer token this stub gave when one is sent (always, with bearer_required). Answers 401 if not."""
        if not secrets.compare_digest(self.headers.get(KEY_HEADER, ""), SERVICE_KEY):
            self.refuse("the service key is required")
            return False
        header = self.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else None
        if (token is None and bearer_required) or (token is not None and token not in STATE.tokens):
            self.refuse("a module-user token that this stub gave is required")
            return False
        return True

    def json_body(self):
        try:
            body = json.loads(self.raw or b"{}")
        except ValueError:
            return {}
        return body if isinstance(body, dict) else {}

    def eneo_route(self):
        """Eneo's own routes, and the control surface. Anything else under /api/v1/ is the BFF role's /api/eneo/ (one set of
        data), once the credentials are checked: the path is rewritten and False returned. True: the request is answered."""
        self.original_path = self.path
        url = urlparse(self.path)
        path, method = url.path, self.command
        # The body is read before anything is answered, so a refusal never leaves it on a connection that is kept alive;
        # an upload's is drained by upload() as it arrives.
        self.raw = None if is_upload(path.strip("/").split("/")) else self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if path in ("/__log", "/__log/"):
            with STATE.lock:
                self.send(200, STATE.log)
            return True
        if path in ("/__reset", "/__reset/", "/__stub/reset"):
            STATE.reset()
            self.send(200, {})
            return True
        if path == "/__stub/stats":
            with STATE.lock:
                self.send(200, dict(STATE.stats))
            return True
        if path == "/__stub/end-session" and method == "POST":
            STATE.tokens.clear()
            self.send(200, {"ok": True})
            return True
        if path == "/module-login" and method == "GET":
            query = {key: values[0] for key, values in parse_qs(url.query).items()}
            if query.get("module_key") != MODULE_KEY or not query.get("redirect_uri") or not query.get("state"):
                self.send(400, {"detail": "module_key, redirect_uri and state are required, and the module key must be this module's"})
                return True
            ticket = secrets.token_urlsafe(24)
            STATE.login_tickets[ticket] = time.time() + 60
            self.send_response(303)
            self.send_header("Location", f"{query['redirect_uri']}?{urlencode({'ticket': ticket, 'state': query['state']})}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return True
        if not path.startswith("/api/v1/"):
            return False
        parts = path.strip("/").split("/")[2:]  # after api/v1
        if method == "GET" and path == LIVE_PATH and self.headers.get("Upgrade", "").lower() == "websocket":
            offered = [p.strip() for p in self.headers.get("Sec-WebSocket-Protocol", "").split(",")]
            ticket = next((p[len("ticket."):] for p in offered if p.startswith("ticket.")), None)
            if LIVE_SUBPROTOCOL not in offered or ticket not in STATE.live_tickets:
                self.send(403, {"detail": "no live ticket this stub gave"})
                return True
            recording = STATE.live_tickets.pop(ticket)
            self.live(subprotocol=LIVE_SUBPROTOCOL, recording=recording,
                      handshake={"subprotocols": offered, "origin": self.headers.get("Origin")})
            return True
        if method == "GET" and len(parts) == 4 and parts[0] == "files" and parts[3] == "download":
            return self.signed_file(parts[1], parts[2], parse_qs(url.query))
        if method == "POST" and path == "/api/v1/module-auth/token/":
            if not self.credentialed():
                return True
            ticket = self.json_body().get("ticket")
            if STATE.login_tickets.pop(ticket, 0) < time.time() if isinstance(ticket, str) else True:
                self.send(400, {"detail": "The ticket is unknown, used or expired."})
            else:
                self.send(200, STATE.new_token())
            return True
        if method == "GET" and parts == ["module-auth", MODULE_KEY, "session"]:
            if self.credentialed(bearer_required=True):
                self.send(200, {"module_key": MODULE_KEY, "tenant_id": TENANT, "user": USER})
            return True
        if method == "POST" and parts == ["module-auth", MODULE_KEY, "token", "refresh"]:
            if self.credentialed(bearer_required=True):
                self.send(200, STATE.new_token())
            return True
        if not self.credentialed():
            return True
        if method == "POST" and len(parts) == 7 and parts[0] == "flows" and parts[2] == "runs" and parts[4] in ("input-files", "artifacts") and parts[6] == "signed-url":
            return self.mint(parts)
        if method == "POST" and len(parts) == 5 and parts[0] == "flows" and parts[2] == "steps" and parts[4] == "live-transcription-sessions":
            return self.live_ticket(parts)
        self.path = "/api/eneo/" + self.path[len("/api/v1/"):]
        return False

    def mint(self, parts):
        """A signed URL for a run's input file or artifact: on this stub, which the backend rebases to the host it reaches it on."""
        fid, run_id, kind, file_id = parts[1], parts[3], parts[4], parts[5]
        known = (AUDIO if kind == "input-files" else {f: PDF for f in FILE.values()})
        if fid not in FLOWS or run_state(run_id) is None or file_id not in known:
            self.send(404, {"code": "flow_run_file_not_found", "detail": "File not found."})
            return True
        signature = secrets.token_urlsafe(16)
        STATE.signatures.add(signature)
        disposition = self.json_body().get("content_disposition") or "attachment"
        query = urlencode({"sig": signature, "disp": disposition})
        route = "audio" if kind == "input-files" else "artifact"
        self.send(200, {"url": f"http://{self.headers.get('Host')}/api/v1/files/{route}/{file_id}/download/?{query}", "expires_at": int(time.time()) + 900})
        return True

    def signed_file(self, route, file_id, query):
        """The file a signed URL names, with Range; the signature is the credential, so no header is asked for."""
        if query.get("sig", [""])[0] not in STATE.signatures:
            self.send(403, {"detail": "The signed URL is not valid."})
        elif route == "audio" and file_id in AUDIO:
            disposition = query.get("disp", ["inline"])[0]
            self.ranged(AUDIO[file_id], "audio/wav", {"Content-Disposition": f'{disposition}; filename="inspelning.wav"'})
        elif route == "artifact" and file_id in FILE.values():
            disposition = query.get("disp", ["inline"])[0]
            self.ranged(PDF, "application/pdf", {"Content-Disposition": f'{disposition}; filename="Protokoll kommunstyrelsen 2026-09-24.pdf"'})
        else:
            self.send(404, {"detail": "File not found."})
        return True

    def live_ticket(self, parts):
        if parts[1] not in FLOWS:
            self.send(404, {"code": "flow_not_found", "detail": "Flow not found."})
            return True
        recording = self.json_body().get("recording_id")
        ticket = secrets.token_urlsafe(16)
        STATE.live_tickets[ticket] = recording if isinstance(recording, str) else ""
        STATE.count("live_tickets")
        self.send(201, {"ticket": ticket, "websocket_path": LIVE_PATH, "subprotocol": LIVE_SUBPROTOCOL,
                        "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat(), "sample_rate": 16000,
                        "max_seconds": 18000, "model": {"id": "7d0c7a8e-8b4c-4c1e-9d3e-2f4b6a1c9e10", "name": "Pianissimo"}})
        return True

    def drain(self):
        """A request's body, read in 64 KB pieces and not kept but for its first 8 KB (the multipart head): (bytes, how, head)."""
        total, head = 0, b""

        def took(data):
            nonlocal total, head
            total += len(data)
            if len(head) < 8192:
                head += data[: 8192 - len(head)]
            if UPLOAD_DELAY:
                time.sleep(UPLOAD_DELAY)

        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    while self.rfile.readline() not in (b"\r\n", b"\n", b""):
                        pass
                    return total, "chunked body complete", head
                left = size
                while left:
                    data = self.rfile.read(min(65536, left))
                    if not data:
                        return total, "eof inside a chunk", head
                    left -= len(data)
                    took(data)
                self.rfile.readline()
        length = self.headers.get("Content-Length")
        if length is None:
            return 0, "no body framing", head
        left = int(length)
        while left:
            data = self.rfile.read(min(65536, left))
            if not data:
                return total, "eof before Content-Length", head
            left -= len(data)
            took(data)
        return total, "Content-Length body complete", head

    def upload(self):
        """An upload: drained, and one record of it in upstream.py's format (deploy/acceptance/upload/). (bytes, head)."""
        started = time.time()
        received, how, head = self.drain()
        finished = time.time()
        record = {
            "request_line": f"{self.command} {self.original_path} {self.request_version}",
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
        }
        with STATE.lock:
            STATE.log.append(record)
            STATE.stats["uploads"] += 1
            STATE.stats["last_upload_bytes"] = received
        return received, head

    # ---- the BFF role ----

    def do_GET(self):
        if self.eneo_route():
            return
        url = urlparse(self.path)
        path = url.path.rstrip("/") + "/"
        if path.startswith("/api/live/") and self.headers.get("Upgrade", "").lower() == "websocket":
            return self.live(recording=parse_qs(url.query).get("recording_id", [""])[0])
        if path == "/api/auth/status/":
            return self.send(200, {"authenticated": True, "user": USER, "session_ends_in": 8 * 60 * 60, "max_upload_bytes": 1024**3})
        if path == "/api/branding/":
            return self.send(200, {"organization": ORGANIZATION})
        if path == "/api/branding/theme.css/":
            return self.send(200, theme_css(ACCENT).encode(), "text/css; charset=utf-8")
        if path in ("/api/branding/logo/light/", "/api/branding/logo/dark/") and CUSTOM_LOGO:
            return self.send(200, LOGOS[path.split("/")[-2]], "image/svg+xml")
        if path == "/api/eneo/flows/":
            listed = [f for f in FLOWS.values() if f["listed"]]
            return self.send(200, {"has_more": False, "count": len(listed), "items": [
                {**f["published"], "is_published": True, "space_id": f["space"][0], "space_name": f["space"][1],
                 "input_type": "audio", "delivery": (f["contract"].get("final_output") or {}).get("delivery")}
                for f in listed]})
        parts = path.strip("/").split("/")
        if len(parts) < 5 or parts[:3] != ["api", "eneo", "flows"]:
            return self.send(404, {"detail": "stub: " + path})
        fid, rest = parts[3], parts[4:]
        f = FLOWS.get(fid)
        if f is None:
            return self.send(404, {"code": "flow_not_found", "detail": "Flow not found."})
        if fid == F4 and rest in (["published"], ["run-contract"]):
            return self.send(409, {"code": "flow_assistant_snapshot_republish_required", "eneo_error_code": 9000,
                                   "message": "Step 1 (Transkribera ljud): Assistant snapshot is missing or uses an "
                                              "unsupported schema_version. Republish the flow before running it."})
        if rest == ["published"]:
            return self.send(200, f["published"])
        if rest == ["run-contract"]:
            return self.send(200, f["contract"])
        if rest == ["graph"]:
            graph = GRAPH_WITH_REVIEW if fid == F2 else GRAPH
            run = run_state(parse_qs(url.query).get("run_id", [""])[0])
            if run is None:
                return self.send(200, graph)
            return self.send(200, {**graph, "nodes": [dict(n, run_status=s) for n, s in zip(graph["nodes"], run["step_status"])]})
        if rest == ["runs"]:
            earlier = [] if fid != F1 else [
                {"id": RUN["done"], "flow_id": fid, "status": "completed", "created_at": "2026-09-23T09:00:00Z"},
                {"id": RUN["failed"], "flow_id": fid, "status": "failed", "created_at": "2026-09-22T14:30:00Z"}]
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
                            input_payload_json={"deltagare": ["Anna Berg", "Erik Lund"]} if fid == F1 else {})
            return self.send(200, body)
        if what == ["steps"]:
            return self.send(200, run["steps"])
        if what == ["review-checkpoints", "active"]:
            return self.send(200, PAUSES.get(run_id))
        if what == ["transcript-corrections"]:
            return self.send(200, corrections(run_id))
        return self.send(404, {"detail": "stub: " + path})

    def do_POST(self):
        if self.eneo_route():
            return
        parts = urlparse(self.path).path.strip("/").split("/")
        if is_upload(parts):
            # An upload is drained as it arrives and never held: a gigabyte must not cost the stub a gigabyte.
            received, head = self.upload()
            if b'filename="langsam' in head:
                time.sleep(6)  # holds the sending view on screen long enough to look at it
            if b'filename="for-lang' in head:
                return self.send(400, {"code": "flow_run_audio_exceeds_limit", "eneo_error_code": 9000,
                                       "message": "Audio exceeds the longest recording"})
            return self.send(201, {"id": new_file_id(received), "filename": "upload"})
        if parts[:2] == ["api", "auth"]:
            return self.send(200, {"ok": True})
        if len(parts) >= 5 and parts[:3] == ["api", "eneo", "flows"]:
            fid, rest = parts[3], parts[4:]
            if len(rest) == 5 and rest[0] == "runs" and rest[2] == "steps" and rest[4] == "transcript-regenerations":
                run_id = new_run_id(next(NEW_RUN))
                STARTED[run_id] = 0
                return self.send(201, {"run": {"id": run_id, "flow_id": fid, "status": "queued", "revision": 1},
                                       "created": True, "source_run_id": rest[1], "correction_revision": 1,
                                       "first_regenerated_step_id": REPORT_STEP_ID})
            # Approving and resuming a pause: answered from copies, so a parallel test still sees the pause as it was.
            if len(rest) == 5 and rest[0] == "runs" and rest[2] == "review-checkpoints" and rest[4] in ("approve", "resume"):
                checkpoint = dict(PAUSES[rest[1]], state="approved")
                if rest[4] == "approve":
                    return self.send(200, checkpoint)
                run_id = new_run_id(next(NEW_RUN))
                STARTED[run_id] = 0
                return self.send(200, {"checkpoint": dict(checkpoint, state="resumed"),
                                       "run": {"id": run_id, "flow_id": fid, "status": "running", "revision": 2,
                                               "flow_version": FLOWS[fid]["published"]["published_version"]}})
            # A retry of a failed run: a child run that reuses the first step.
            if len(rest) == 3 and rest[0] == "runs" and rest[2] == "retry":
                run_id = new_run_id(next(NEW_RUN))
                STARTED[run_id] = 0
                return self.send(201, {"run": {"id": run_id, "flow_id": fid, "status": "queued",
                                               "flow_version": FLOWS[fid]["published"]["published_version"]},
                                       "created": True, "source_run_id": rest[1],
                                       "first_executed_step_order": 2, "reused_step_orders": [1]})
            if rest == ["runs"]:
                if fid == F3:
                    return self.send(409, {"code": "flow_run_stale_version", "detail": "The flow has a newer published version."})
                run_id = new_run_id(next(NEW_RUN))
                STARTED[run_id] = 0
                return self.send(201, {"id": run_id, "flow_id": fid, "status": "queued",
                                       "flow_version": FLOWS[fid]["published"]["published_version"]})
        return self.send(404, {"detail": "stub: " + self.path})


    def do_PATCH(self):
        if self.eneo_route():
            return
        body = json.loads(self.raw or b"{}")
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


ThreadingHTTPServer.request_queue_size = 64
ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
