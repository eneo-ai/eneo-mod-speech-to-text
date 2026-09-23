import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AudioPlayer } from "../components/flow/AudioPlayer";
import { ReadyPanel } from "../components/flow/ReadyPanel";
import { UploadPanel } from "../components/flow/UploadPanel";
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

test("the player is our own: a named play button, a named slider over the known length, and m:ss / m:ss", () => {
  const html = renderToStaticMarkup(
    createElement(AudioPlayer, {
      sources: [
        { url: "blob:a", durationMs: 4_000 },
        { url: "blob:b", durationMs: 2_000 },
      ],
      label: "Inspelning 23 sep 16:13",
    }),
  );
  assert.match(html, /role="group" aria-label="Uppspelning: Inspelning 23 sep 16:13"/);
  assert.match(html, /<button[^>]*aria-label="Spela upp"/);
  assert.match(html, /role="slider"[^>]*aria-label="Position"|aria-label="Position"[^>]*role="slider"/);
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
  const empty = renderToStaticMarkup(createElement(UploadPanel, { step, file: null, audio: true, onPick: noop, onDrop: noop }));
  assert.match(empty, /Flödet tar emot MP3, WAV, M4A och WebM, högst 200\u00a0MB\./);
  assert.doesNotMatch(empty, /audio\//);

  const chosen = renderToStaticMarkup(
    createElement(UploadPanel, {
      step,
      file: { blob: new Blob(["x".repeat(1_300_000)]), filename: "mote.mp3", durationMs: 32 * 60_000 },
      audio: true,
      onPick: noop,
      onDrop: noop,
    }),
  );
  assert.match(chosen, />mote\.mp3</);
  assert.match(chosen, /1,2\u00a0MB · 32 min/);
  assert.match(chosen, />Byt fil<\/button>/);
});
