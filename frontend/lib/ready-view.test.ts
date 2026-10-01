import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AudioPlayer, usePlayback } from "../components/flow/AudioPlayer";
import { ReadyPanel } from "../components/flow/ReadyPanel";
import { UploadPanel } from "../components/flow/UploadPanel";
import { computeAccessibleName } from "dom-accessibility-api";
import type { LiveSnapshot } from "./live-transcriber";
import type { StoredRecording } from "./recording-store";
import { parse } from "./test-dom";

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

/** A button of the markup by its visible words. */
const hasButton = (html: string, name: string) => [...parse(html).querySelectorAll("button")].some((button) => button.textContent?.trim() === name);

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
  assert.ok(hasButton(kept, "Skapa text"));
  assert.match(kept, /Inspelningen finns kvar på enheten tills texten är skapad\./);
  assert.match(kept, /Den slutliga texten skapas när du väljer Skapa text\./);
  assert.match(view(false), /Stäng inte fliken innan texten är skapad\./);
  assert.doesNotMatch(kept + view(false), /[Dd]okument/);
});

test("the ready state names the recording for people, never as a file or a type, with one primary next step", () => {
  const html = renderToStaticMarkup(
    createElement(ReadyPanel, { recording, persistent: true, problem: null, onCreate: noop, onDiscard: noop }),
  );
  assert.equal(parse(html).querySelector("h2")?.textContent, "Inspelningen är klar");
  assert.match(html, /Inspelning 23 sep 16:13 · 32 min/);
  for (const name of ["Skapa dokument", "Spara som fil", "Ta bort"]) assert.ok(hasButton(html, name), name);
  assert.match(html, /Inspelningen finns kvar på enheten tills dokumentet är skapat\./);
  assert.doesNotMatch(html, /audio\/|webm|\.webm|recording-\d|<audio[^>]*controls/i, "no MIME type, file name or native controls");
  assert.doesNotMatch(html, /Fortsätt spela in/, "offered only when the recorder can continue a stopped recording");

  const withContinue = renderToStaticMarkup(
    createElement(ReadyPanel, { recording, persistent: false, problem: null, onCreate: noop, onContinue: noop, onDiscard: noop }),
  );
  assert.ok(hasButton(withContinue, "Fortsätt spela in"));
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
  // The design system says a button's emphasis in data-variant: the filled one is "primary".
  const variants = (html: string) =>
    Object.fromEntries([...parse(html).querySelectorAll("button")].map((button) => [button.textContent?.trim(), button.getAttribute("data-variant")]));
  const ready = (durationMs: number, onContinue?: () => void) =>
    renderToStaticMarkup(
      createElement(ReadyPanel, { recording: { ...recording, durationMs }, persistent: true, problem: null, onCreate: noop, onContinue, onDiscard: noop }),
    );
  const note = /Inspelningen blev mycket kort\. Välj Fortsätt spela in om den stoppades av misstag\./;
  const moment = ready(1_200, noop);
  assert.match(moment, note);
  assert.equal(variants(moment)["Fortsätt spela in"], "primary");
  assert.equal(variants(moment)["Skapa dokument"], "secondary");

  const meeting = ready(32 * 60_000, noop);
  assert.doesNotMatch(meeting, note);
  assert.equal(variants(meeting)["Skapa dokument"], "primary");
  assert.equal(variants(meeting)["Fortsätt spela in"], "secondary");
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
  const draft = parse(html);
  const heading = draft.querySelector("h3");
  assert.equal(heading?.textContent, "Preliminär text");
  assert.match(html, /Den slutliga texten skapas med dokumentet\./);
  const region = draft.querySelector('[role="region"]');
  assert.equal(region?.getAttribute("aria-labelledby"), heading?.id, "the draft is named by its heading");
  assert.deepEqual([...(region?.querySelectorAll("p") ?? [])].map((p) => p.textContent), ["Välkomna till nämndens möte. Första punkten.", "Budgeten."]);
  assert.equal(region?.getAttribute("tabindex"), "0", "a long draft scrolls by keyboard too");
  assert.ok(hasButton(html, "Kopiera"));
  for (const nothing of [null, live([])]) {
    const none = renderToStaticMarkup(
      createElement(ReadyPanel, { recording, persistent: true, problem: null, live: nothing, onCreate: noop, onDiscard: noop }),
    );
    assert.doesNotMatch(none, /Preliminär text/);
  }
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
  assert.match(sent, /<button[^>]*aria-label="Öppna, körningen [^"]+"[^>]*>(?:<[^>]+>)*Öppna(?:<[^>]+>)*<\/button>/, "the run Eneo has, one tap away, named by which run it is");
  assert.ok(hasButton(sent, "Ta bort inspelningen från enheten"));

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
  assert.ok(hasButton(notSent, "Ta bort"));
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
  const player = parse(html);
  assert.equal(player.querySelector("button")?.getAttribute("aria-label"), "Spela upp");
  const slider = player.querySelector('[role="slider"]')!;
  assert.equal(computeAccessibleName(slider), "Position i inspelningen");
  assert.equal(slider.getAttribute("aria-valuemax"), "6", "the known length of both parts");
  assert.equal(slider.getAttribute("aria-valuetext"), "0:00 av 0:06");
  assert.match(html, />0:00 \/ 0:06</);
  assert.equal(player.querySelector("audio")?.hasAttribute("controls"), false, "never the browser's own controls");
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
  assert.match(chosen, /<p[^>]*role="status"[^>]*>Vald fil: mote\.mp3<\/p>/, "the choice is announced");
  assert.match(empty, /<p[^>]*role="status"[^>]*><\/p>/, "the status is there before a file is chosen");
  assert.match(chosen, /1,2\u00a0MB · 32 min/);
  assert.match(chosen, /<button[^>]*>(?:<[^>]+>)*Byt fil(?:<[^>]+>)*<\/button>/);
});
