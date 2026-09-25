import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AudioPlayer, usePlayback } from "../components/flow/AudioPlayer";
import { ReadyPanel } from "../components/flow/ReadyPanel";
import { UploadPanel } from "../components/flow/UploadPanel";
import type { LiveSnapshot } from "./live-transcriber";
import type { StoredRecording } from "./recording-store";

const recording: StoredRecording = {
  id: "rec-1",
  ownerId: "user-1",
  flowId: "flow-1",
  flowName: "Nämndmöte till rapport",
  stepId: "step-audio",
  inputMode: "record",
  mimeType: "audio/webm;codecs=opus",
  startedAt: new Date(2026, 8, 23, 16, 13).getTime(),
  durationMs: 32 * 60_000,
  state: "stopped",
  parts: [{ index: 0, startedAt: 0, durationMs: 32 * 60_000, bytes: 87_859, chunks: 3, fileId: null }],
  runId: null,
};

const noop = () => {};

test("for a flow that makes text, the ready state speaks of the text, never the document", () => {
  const live = {
    getSnapshot: (): LiveSnapshot => ({ status: "ended", started: true, complete: true, pending: "", pieces: [{ text: "Hej.", opensParagraph: true }] }),
    subscribe: () => () => {},
    listen: noop,
    setRecording: noop,
    stop: noop,
    dispose: noop,
  };
  const view = (persistent: boolean) =>
    renderToStaticMarkup(createElement(ReadyPanel, { recording, persistent, problem: null, live, makesText: true, onCreate: noop, onDiscard: noop }));
  const kept = view(true);
  assert.match(kept, />Skapa text<\/button>/);
  assert.match(kept, /Inspelningen finns kvar på enheten tills texten är skapad\./);
  assert.match(kept, /Den slutliga texten skapas när du väljer Skapa text\./);
  assert.match(view(false), /Stäng inte fliken innan texten är skapad\./);
  assert.doesNotMatch(kept + view(false), /[Dd]okument/);
});

test("the ready state names the recording for people, never as a file or a type, with one primary next step", () => {
  const html = renderToStaticMarkup(
    createElement(ReadyPanel, { recording, persistent: true, problem: null, onCreate: noop, onDiscard: noop }),
  );
  assert.match(html, /<h2[^>]*>Inspelningen är klar<\/h2>/);
  assert.match(html, /Inspelning 23 sep 16:13 · 32 min/);
  assert.match(html, />Skapa dokument<\/button>/);
  assert.match(html, />Spara som fil<\/button>/);
  assert.match(html, />Ta bort<\/button>/);
  assert.match(html, /Inspelningen finns kvar på enheten tills dokumentet är skapat\./);
  assert.doesNotMatch(html, /audio\/|webm|\.webm|recording-\d|<audio[^>]*controls/i, "no MIME type, file name or native controls");
  assert.doesNotMatch(html, /Fortsätt spela in/, "offered only when the recorder can continue a stopped recording");

  const withContinue = renderToStaticMarkup(
    createElement(ReadyPanel, { recording, persistent: false, problem: null, onCreate: noop, onContinue: noop, onDiscard: noop }),
  );
  assert.match(withContinue, />Fortsätt spela in<\/button>/);
  assert.match(withContinue, /Inspelningen finns bara i den här fliken\./, "the storage line stays honest");

  const short = renderToStaticMarkup(
    createElement(ReadyPanel, {
      recording: { ...recording, durationMs: 7_600 },
      persistent: true,
      problem: null,
      onCreate: noop,
      onDiscard: noop,
    }),
  );
  assert.match(short, /Inspelning 23 sep 16:13 · 7 s/, "whole seconds, as the timer showed 0:07 at Stoppa");
});

test("a recording of a moment says so, and makes Fortsätt spela in the one filled action", () => {
  const variants = (html: string) =>
    Object.fromEntries(
      [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>(?:<svg.*?<\/svg>)?([^<]+)<\/button>/g)].map(([, classes, label]) => [
        label,
        classes.includes("bg-primary") ? "filled" : "outline",
      ]),
    );
  const ready = (durationMs: number, onContinue?: () => void) =>
    renderToStaticMarkup(
      createElement(ReadyPanel, { recording: { ...recording, durationMs }, persistent: true, problem: null, onCreate: noop, onContinue, onDiscard: noop }),
    );
  const note = /Inspelningen blev mycket kort\. Välj Fortsätt spela in om den stoppades av misstag\./;
  const moment = ready(1_200, noop);
  assert.match(moment, note);
  assert.equal(variants(moment)["Fortsätt spela in"], "filled");
  assert.equal(variants(moment)["Skapa dokument"], "outline");

  const meeting = ready(32 * 60_000, noop);
  assert.doesNotMatch(meeting, note);
  assert.equal(variants(meeting)["Skapa dokument"], "filled");
  assert.equal(variants(meeting)["Fortsätt spela in"], "outline");
  assert.doesNotMatch(ready(1_200), note, "nothing to offer when the recorder cannot go on");
});

test("after Stoppa, Strömma's live text stays to read and copy, marked as preliminary", () => {
  const snapshot: LiveSnapshot = {
    status: "ended",
    started: true,
    complete: false,
    pending: "",
    pieces: [
      { text: "Välkomna till nämndens möte.", opensParagraph: true },
      { text: "Första punkten.", opensParagraph: false },
      { text: "Budgeten.", opensParagraph: true },
    ],
  };
  const live = (pieces: LiveSnapshot["pieces"]) => ({
    getSnapshot: () => ({ ...snapshot, pieces }),
    subscribe: () => () => {},
    listen: noop,
    setRecording: noop,
    stop: noop,
    dispose: noop,
  });
  const html = renderToStaticMarkup(
    createElement(ReadyPanel, { recording, persistent: true, problem: null, live: live(snapshot.pieces), onCreate: noop, onDiscard: noop }),
  );
  assert.match(html, /<h3 id="([^"]+)"[^>]*>Preliminär text<\/h3>/);
  assert.match(html, /Den slutliga texten skapas med dokumentet\./);
  assert.match(html, /<p>Välkomna till nämndens möte\. Första punkten\.<\/p><p>Budgeten\.<\/p>/);
  assert.match(html, /role="region"[^>]*tabindex="0"|tabindex="0"[^>]*role="region"/, "a long draft scrolls by keyboard too");
  assert.match(html, />Kopiera<\/button>/);
  for (const nothing of [null, live([])]) {
    const none = renderToStaticMarkup(
      createElement(ReadyPanel, { recording, persistent: true, problem: null, live: nothing, onCreate: noop, onDiscard: noop }),
    );
    assert.doesNotMatch(none, /Preliminär text/);
  }
});

test("while Strömma's final text is on its way, Skapa dokument says so and waits, keeping its focus", () => {
  const html = renderToStaticMarkup(
    createElement(ReadyPanel, { recording, persistent: true, problem: null, finishing: true, onCreate: noop, onDiscard: noop }),
  );
  assert.match(html, /<button[^>]*aria-disabled="true"[^>]*>.*Slutför texten…<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>.*Slutför texten/, "not disabled: focus stays on it");
});

test("a recording Eneo already has shows the earlier runs where the user is, and offers deleting it from the device", () => {
  const sent = renderToStaticMarkup(
    createElement(ReadyPanel, {
      recording: { ...recording, state: "uploaded" },
      persistent: true,
      problem: { title: "Inspelningen har redan skickats. Körningen finns under Tidigare körningar.", sent: true },
      onCreate: noop,
      onDiscard: noop,
      earlierRuns: { runs: [{ id: "run-1", flow_id: "flow-1", status: "completed", created_at: "2026-09-23T10:12:00Z" }], hasMore: false, loading: false, failed: null },
      onOpenRun: noop,
    }),
  );
  assert.match(sent, /Tidigare körningar/);
  assert.match(sent, />Öppna<span class="sr-only">/, "the run Eneo has, one tap away");
  assert.match(sent, />Ta bort inspelningen från enheten<\/button>/);

  const notSent = renderToStaticMarkup(
    createElement(ReadyPanel, {
      recording,
      persistent: true,
      problem: null,
      onCreate: noop,
      onDiscard: noop,
      earlierRuns: { runs: [{ id: "run-1", flow_id: "flow-1", status: "completed", created_at: "2026-09-23T10:12:00Z" }], hasMore: false, loading: false, failed: null },
      onOpenRun: noop,
    }),
  );
  assert.doesNotMatch(notSent, /Tidigare körningar/, "the ready state lists runs only once Eneo has this recording");
  assert.match(notSent, />Ta bort<\/button>/);
});

test("the player is our own: a named play button, a named slider over the known length, and m:ss / m:ss", () => {
  const sources = [
    { url: "blob:a", durationMs: 4_000 },
    { url: "blob:b", durationMs: 2_000 },
  ];
  function Ready() {
    return createElement(AudioPlayer, { playback: usePlayback(sources), label: "Inspelning 23 sep 16:13" });
  }
  const html = renderToStaticMarkup(createElement(Ready));
  assert.match(html, /role="group" aria-label="Uppspelning: Inspelning 23 sep 16:13"/);
  assert.match(html, /<button[^>]*aria-label="Spela upp"/);
  assert.match(html, /role="slider"[^>]*aria-label="Position i inspelningen"|aria-label="Position i inspelningen"[^>]*role="slider"/);
  assert.match(html, /aria-valuemax="6"/, "the known length of both parts");
  assert.match(html, /aria-valuetext="0:00 av 0:06"/);
  assert.match(html, />0:00 \/ 0:06</);
  assert.doesNotMatch(html, /controls/);
});

test("Ladda upp says what the flow takes in plain words, and a chosen file shows its size and length", () => {
  const step = {
    step_id: "step-audio",
    input_format: "audio",
    max_file_size_bytes: 200 * 1024 * 1024,
    accepted_mimetypes: ["audio/mpeg", "audio/wav", "audio/x-m4a", "audio/webm"],
  };
  const empty = renderToStaticMarkup(createElement(UploadPanel, { step, file: null, audio: true, inputRef: null, onChoose: noop }));
  assert.match(empty, /Flödet tar emot MP3, WAV, M4A och WebM, högst 200\u00a0MB\./);
  const timed = renderToStaticMarkup(
    createElement(UploadPanel, { step: { ...step, max_duration_seconds: 5 * 3_600 }, file: null, audio: true, inputRef: null, onChoose: noop }),
  );
  assert.match(timed, /Flödet tar emot MP3, WAV, M4A och WebM, högst 200\u00a0MB och 5\u00a0h\./);
  assert.doesNotMatch(empty.replace(/<input[^>]*>/, ""), /audio\//, "the chooser's accept list is the only place types show");

  const chosen = renderToStaticMarkup(
    createElement(UploadPanel, {
      step,
      file: { blob: new Blob(["x".repeat(1_300_000)]), filename: "mote.mp3", durationMs: 32 * 60_000 },
      audio: true,
      inputRef: null,
      onChoose: noop,
    }),
  );
  assert.match(chosen, />mote\.mp3</);
  assert.match(chosen, /<p role="status" class="sr-only">Vald fil: mote\.mp3<\/p>/, "the choice is announced");
  assert.match(empty, /<p role="status" class="sr-only"><\/p>/, "the status is there before a file is chosen");
  assert.match(chosen, /1,2\u00a0MB · 32 min/);
  assert.match(chosen, />Byt fil<\/button>/);
});
