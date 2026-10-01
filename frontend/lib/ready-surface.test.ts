import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";

import { loginState } from "./login-state";
import type { StoredRecording } from "./recording-store";
import { cleanup, installDom, mount } from "./test-dom";

// The ready state where it is acted on: focus, presses and the delete question, which static markup cannot show.
installDom();
afterEach(cleanup);

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

const named = (within: ParentNode, name: string) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find((button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name) ?? null;

async function ready(props: Record<string, unknown> = {}) {
  const { ReadyPanel } = await import("../components/flow/ReadyPanel");
  const calls = { create: 0, discard: 0 };
  const view = await mount(
    createElement(ReadyPanel, {
      recording,
      persistent: true,
      problem: null,
      onCreate: () => void (calls.create += 1),
      onDiscard: () => void (calls.discard += 1),
      ...props,
    }),
  );
  return { ...view, calls };
}

const question = () => document.querySelector<HTMLDialogElement>('[role="alertdialog"]');

test("while Strömma's final text is on its way, Skapa dokument says so and waits, keeping its focus", async () => {
  const view = await ready({ finishing: true });
  const create = named(view.container, "Slutför texten…")!;
  assert.ok(create, "the button says what it waits for");
  assert.equal(create.disabled, false, "not disabled: focus stays on it");
  assert.equal(create.getAttribute("aria-busy"), "true", "and says that it is busy");
  await view.act(async () => create.focus());
  await view.act(async () => create.click());
  assert.equal(document.activeElement, create, "a press leaves the focus where it was");
  assert.equal(named(view.container, "Skapa dokument"), null, "it is not offered while it waits");
});

test("a press on Skapa dokument creates, once the text is in", async () => {
  const view = await ready();
  await view.act(async () => named(view.container, "Skapa dokument")!.click());
  assert.equal(view.calls.create, 1);
});

test("with nothing to play, the player is left out and the next steps are still there", async () => {
  // The test document's store holds no parts of the recording: as when the device has lost them.
  const view = await ready();
  assert.equal(view.container.querySelector('[role="group"][aria-label^="Uppspelning"]'), null, "no player for a recording it cannot read");
  for (const name of ["Skapa dokument", "Spara som fil", "Ta bort"]) assert.ok(named(view.container, name), name);
});

test("a recording that cannot be saved as a file says so, and Spara som fil is still there to try again", async () => {
  // The device has the parts, and the browser cannot turn them into a download.
  const { recordingStore } = await import("./recording-store");
  const store = await recordingStore();
  const readParts = store.readParts;
  const createObjectURL = URL.createObjectURL;
  store.readParts = async () => [{ index: 0, filename: "inspelning.webm", blob: new Blob(["x"]) }] as never;
  try {
    const view = await ready();
    await view.act(async () => undefined);
    URL.createObjectURL = () => {
      throw new Error("no object URLs");
    };
    await view.act(async () => named(view.container, "Spara som fil")!.click());
    await view.act(async () => undefined);
    assert.match(view.container.textContent ?? "", /Inspelningen kunde inte sparas som fil\./);
    assert.ok(named(view.container, "Spara som fil"), "and the button is still there");
  } finally {
    store.readParts = readParts;
    URL.createObjectURL = createObjectURL;
  }
});

test("the delete question: Avbryt and Escape keep the recording; Ta bort discards once, closing first", async () => {
  const view = await ready();
  const trigger = named(view.container, "Ta bort")!;
  assert.equal(question()?.hasAttribute("open") ?? false, false, "nothing is asked until Ta bort is pressed");

  await view.act(async () => trigger.click());
  assert.ok(question()?.hasAttribute("open"), "the question opens");
  assert.equal(question()?.getAttribute("aria-label") ?? question()?.textContent?.includes("Ta bort inspelningen?"), true);
  await view.act(async () => named(question()!, "Avbryt")!.click());
  assert.equal(question()?.hasAttribute("open"), false, "Avbryt closes it");
  assert.equal(document.activeElement, trigger, "and gives the focus back to Ta bort");
  assert.equal(view.calls.discard, 0, "the recording is kept");

  await view.act(async () => trigger.click());
  await view.act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(question()?.hasAttribute("open"), false, "Escape closes it");
  assert.equal(view.calls.discard, 0, "and keeps the recording");

  await view.act(async () => trigger.click());
  await view.act(async () => named(question()!, "Ta bort")!.click());
  assert.equal(view.calls.discard, 1, "Ta bort discards once");
  assert.equal(question()?.hasAttribute("open"), false, "and the question is closed");
});

test("the delete question is covered while the login has ended, and is back, as it was, with the new login", async () => {
  const anna = { id: "user-1", email: "anna@example.se", username: "Anna Berg" };
  const release = loginState.begin(anna);
  try {
    const view = await ready();
    const trigger = named(view.container, "Ta bort")!;
    await view.act(async () => trigger.click());
    assert.ok(question()?.hasAttribute("open"), "asked");
    await view.act(async () => loginState.ended());
    assert.equal(question()?.hasAttribute("open"), false, "the login ends: nothing of the question stays open over the sign-in dialog");
    await view.act(async () => loginState.observe({ authenticated: true, auth_mode: "eneo_sso", user: anna }));
    assert.ok(question()?.hasAttribute("open"), "the same person signs in again: the question is back");
    // Asked again with nothing of the page focused, it still gives the focus back to Ta bort when it is answered.
    (document.activeElement as HTMLElement | null)?.blur();
    await view.act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(question()?.hasAttribute("open"), false);
    assert.equal(document.activeElement, trigger, "back on the button that asked");
    assert.equal(view.calls.discard, 0);
  } finally {
    release();
  }
});
