import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement, type ComponentProps } from "react";

import { recordingDetails, resumableRecording, UnsentRecordings, type UnsentRecording } from "../components/UnsentRecordings";
import { IN_USE_ELSEWHERE, type StoredRecording } from "./recording-store";
import { button, cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(cleanup);

const at = (day: number, hours: number, minutes: number) =>
  new Date(2026, 8, day, hours, minutes).getTime();

const recording = (id: string, durationMs: number, startedAt: number): StoredRecording => ({
  id,
  ownerId: "user-1",
  flowId: "flow-1",
  flowName: "Nämndmöte till rapport",
  stepId: "step-audio",
  inputMode: "record",
  mimeType: "audio/webm;codecs=opus",
  startedAt,
  durationMs,
  state: "stopped",
  parts: [],
  runId: null,
});

const render = ({
  recordings,
  ...props
}: Partial<Omit<ComponentProps<typeof UnsentRecordings>, "list">> & { recordings: UnsentRecording[] }) =>
  mount(createElement(UnsentRecordings, { list: { recordings, unreadable: false, retry: () => {} }, onSend: () => {}, sendLabel: () => "Skapa dokument", ...props }));
const rowsOf = (container: HTMLElement) => [...container.querySelectorAll("li")];
const labels = (row: Element) => [...row.querySelectorAll("button")].map((b) => b.textContent!.trim());
/** The element the row's actions say they are described by: what a screen reader reads after each button's name. */
const summaryOf = (row: Element) => {
  const ids = new Set([...row.querySelectorAll("button[aria-describedby]")].map((b) => b.getAttribute("aria-describedby")));
  assert.equal(ids.size, 1, "one summary for every action");
  return document.getElementById([...ids][0]!)!;
};
/** The filled action(s): the design system marks them `data-variant="primary"`. */
const filled = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].filter((b) => b.getAttribute("data-variant") === "primary").map((b) => b.textContent!.trim());

test("an unsent recording keeps the name it was made with, then its flow and length", async () => {
  assert.equal(recordingDetails(recording("a", 42 * 60_000, at(23, 10, 12)), { withFlowName: true }), "Nämndmöte till rapport · 42 min");
  assert.equal(recordingDetails(recording("b", 65 * 60_000, at(22, 16, 40))), "1 h 5 min");
  const { container } = await render({ recordings: [recording("c", 30_000, at(20, 9, 5))], withFlowName: true });
  // The name the ready panel shows (lib/format recordingName), then its flow and length.
  assert.deepEqual([...summaryOf(rowsOf(container)[0]).children].map((line) => line.textContent), ["Inspelning 20 sep 09:05", "Nämndmöte till rapport · 30 s"]);
});

test("one unsent recording is spoken of in the singular", async () => {
  const one = await render({ recordings: [recording("a", 60_000, at(23, 10, 12))] });
  assert.equal(one.container.querySelector("h2")?.textContent, "En inspelning har inte skickats");
  assert.match(one.container.textContent!, /Den finns kvar på den här enheten tills den har skickats\./);
  await one.unmount();
  const two = await render({ recordings: [recording("a", 60_000, at(23, 10, 12)), recording("b", 60_000, at(23, 9, 0))] });
  assert.equal(two.container.querySelector("h2")?.textContent, "2 inspelningar har inte skickats");
  assert.match(two.container.textContent!, /De finns kvar på den här enheten tills de har skickats\./);
});

test("where the browser may delete the recordings the list does not promise they stay", async () => {
  const one = await render({ recordings: [recording("a", 60_000, at(23, 10, 12))], evictable: true });
  assert.match(one.container.textContent!, /Den finns på den här enheten, men webbläsaren kan rensa den om den ligger kvar osänd för länge\./);
  assert.doesNotMatch(one.container.textContent!, /tills den har skickats/);
  await one.unmount();
  const two = await render({
    recordings: [recording("a", 60_000, at(23, 10, 12)), recording("b", 60_000, at(23, 9, 0))],
    evictable: true,
  });
  assert.match(two.container.textContent!, /De finns på den här enheten, men webbläsaren kan rensa dem om de ligger kvar osända för länge\./);
});

test("each unsent recording offers Skapa dokument, Spara som fil and Ta bort, described by its summary", async () => {
  const { container } = await render({
    recordings: [recording("a", 60_000, at(23, 10, 12)), recording("b", 120_000, at(23, 9, 0))],
    withFlowName: true,
  });
  const rows = rowsOf(container);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual(labels(row), ["Skapa dokument", "Spara som fil", "Ta bort"]);
    assert.match(summaryOf(row).textContent!, /^Inspelning \d+ sep \d\d:\d\d/, "the summary is the recording's name and details");
  }
  const { container: nothing } = await render({ recordings: [] });
  assert.equal(nothing.innerHTML, "");
});

test("the actions call back with their recording, and Fortsätt spela in only where a recorder can take over", async () => {
  const interrupted = { ...recording("a", 60_000, at(23, 10, 12)), state: "paused" as const };
  const finished = recording("b", 60_000, at(23, 9, 0));
  const sent: string[] = [];
  const continued: string[] = [];
  const { container, act } = await render({
    recordings: [interrupted, finished],
    onSend: (r) => void sent.push(r.id),
    onContinue: (r) => void continued.push(r.id),
  });
  const [first, second] = rowsOf(container);
  assert.deepEqual(labels(first), ["Fortsätt spela in", "Skapa dokument", "Spara som fil", "Ta bort"]);
  assert.deepEqual(labels(second), ["Skapa dokument", "Spara som fil", "Ta bort"]);
  await act(async () => button(first, "Fortsätt spela in")!.click());
  await act(async () => button(second, "Skapa dokument")!.click());
  assert.deepEqual([continued, sent], [["a"], ["b"]]);
  const { container: list } = await render({ recordings: [interrupted] });
  assert.equal(button(list, "Fortsätt spela in"), null, "the flow list has no recorder to continue in");
});

test("without Web Locks, another tab's recording is offered only as a file to save, and says why", async () => {
  const elsewhere = { ...recording("a", 60_000, at(23, 10, 12)), state: "paused" as const, exportOnly: true };
  const { container } = await render({ recordings: [elsewhere, recording("b", 60_000, at(23, 9, 0))], onContinue: () => {} });
  const [first, second] = rowsOf(container);
  assert.deepEqual(labels(first), ["Spara som fil"]);
  assert.match(first.textContent!, /I den här webbläsaren kan den bara sparas som fil\./);
  assert.equal(summaryOf(first).textContent?.startsWith("Inspelning"), true, "the one action is still described by the summary");
  assert.deepEqual(labels(second), ["Skapa dokument", "Spara som fil", "Ta bort"], "a recording this tab may change keeps every action");
});

test("a recording a reload cut off says so and how to go on, with Fortsätt spela in the one filled action", async () => {
  const cutOff = (id: string) => ({ ...recording(id, 60_000, at(23, 10, 12)), state: "recording" as const });
  const one = await render({ recordings: [cutOff("a")], onContinue: () => {} });
  assert.equal(one.container.querySelector("h2")?.textContent, "Inspelningen avbröts");
  assert.match(one.container.textContent!, /Välj Fortsätt spela in så fortsätter den i samma inspelning\./);
  assert.deepEqual(filled(one.container), ["Fortsätt spela in"]);
  await one.unmount();

  const two = await render({ recordings: [cutOff("a"), cutOff("b")], onContinue: () => {} });
  assert.deepEqual(filled(two.container), ["Fortsätt spela in"], "one filled action, on the first");
  assert.equal(button(rowsOf(two.container)[0], "Fortsätt spela in")?.getAttribute("data-variant"), "primary");
  assert.equal(resumableRecording([recording("c", 60_000, at(23, 9, 0)), cutOff("a"), cutOff("b")])?.id, "a");
  await two.unmount();

  // The flow list has no recorder to continue in: its rows' actions are all quiet, beside the flows.
  const list = await render({ recordings: [cutOff("a")], withFlowName: true });
  assert.equal(list.container.querySelector("h2")?.textContent, "En inspelning har inte skickats");
  assert.deepEqual(filled(list.container), []);
  await list.unmount();
  const stopped = await render({ recordings: [recording("c", 60_000, at(23, 9, 0))], onContinue: () => {} });
  assert.deepEqual(filled(stopped.container), [], "the setup's own action stays the filled one");
  assert.equal(resumableRecording([{ ...cutOff("a"), exportOnly: true }]), undefined, "another tab's recording is only saved");
});

test("once the person chooses another way on the page, a cut-off recording's Fortsätt spela in is no longer the filled action", async () => {
  const cutOff = { ...recording("a", 60_000, at(23, 10, 12)), state: "recording" as const };
  const { container } = await render({ recordings: [cutOff], onContinue: () => {}, filled: false });
  assert.equal(container.querySelector("h2")?.textContent, "Inspelningen avbröts");
  assert.deepEqual(filled(container), [], "the setup's own action is the filled one");
  assert.ok(button(rowsOf(container)[0], "Fortsätt spela in"), "it is still offered");
});

const focused = () => (document.activeElement as HTMLElement | null)?.textContent?.trim();

test("Ta bort asks first, with the focus on Avbryt, and gives the focus back to Ta bort when it is not wanted", async () => {
  const { container, act } = await render({ recordings: [recording("a", 60_000, at(23, 10, 12))] });
  const row = rowsOf(container)[0];
  await act(async () => button(row, "Ta bort")!.click());
  const question = row.querySelector('[role="group"]')!;
  const name = document.getElementById(question.getAttribute("aria-labelledby")!)!;
  assert.equal(name.textContent, "Ta bort inspelningen från enheten? Det går inte att ångra.");
  assert.deepEqual(labels(question), ["Avbryt", "Ta bort"], "the question is the only thing to answer");
  assert.equal(button(row, "Skapa dokument"), null, "the other actions wait");
  assert.equal(focused(), "Avbryt");

  await act(async () => button(row, "Avbryt")!.click());
  assert.equal(row.querySelector('[role="group"]'), null);
  assert.deepEqual(labels(row), ["Skapa dokument", "Spara som fil", "Ta bort"]);
  assert.equal(focused(), "Ta bort");
});

test("a recording that cannot be saved or removed says so in an alert, and a removal that failed closes the question", async (t) => {
  const saving = await import("../components/save-recording");
  const store = await import("./recording-store");
  const { container, act } = await render({ recordings: [recording("a", 60_000, at(23, 10, 12))] });
  const row = rowsOf(container)[0];
  const alert = () => [...row.querySelectorAll('[role="alert"]')].map((a) => a.textContent?.trim());
  assert.deepEqual(alert(), [], "nothing is said before something fails");

  t.mock.method(saving, "saveRecordingAsFiles", async () => {
    throw new Error("disk");
  });
  await act(async () => button(row, "Spara som fil")!.click());
  assert.deepEqual(alert(), ["Inspelningen kunde inte sparas som fil. Försök igen."]);

  t.mock.method(store, "recordingStore", async () => ({
    remove: async () => {
      throw new Error(IN_USE_ELSEWHERE);
    },
  }));
  await act(async () => button(row, "Ta bort")!.click());
  await act(async () => button(row.querySelector('[role="group"]')!, "Ta bort")!.click());
  assert.deepEqual(alert(), [IN_USE_ELSEWHERE]);
  assert.equal(row.querySelector('[role="group"]'), null, "the question is closed");
  assert.equal(focused(), "Ta bort", "and the focus is back where it was");
});

test("recordings the device's store cannot list are not passed over: a notice stands in the list's place, and Försök igen reads again", async () => {
  const { useUnsentRecordings } = await import("../components/UnsentRecordings");
  const { recordingStore } = await import("./recording-store");
  const store = await recordingStore();
  const listUnsent = store.listUnsent;
  let readable = false;
  store.listUnsent = async () => {
    if (!readable) throw new Error("the database is not readable");
    return [recording("a", 60_000, at(23, 10, 12))];
  };
  function Unsent() {
    return createElement(UnsentRecordings, { list: useUnsentRecordings("user-1"), onSend: () => {}, sendLabel: () => "Skapa dokument" });
  }
  try {
    const { container, act } = await mount(createElement(Unsent));
    await act(async () => undefined);
    assert.match(container.textContent!, /Kunde inte läsa inspelningar som inte skickats på den här enheten\./);
    assert.equal(rowsOf(container).length, 0, "no list to read as if it were the whole truth");

    readable = true;
    await act(async () => button(container, "Försök igen")!.click());
    assert.doesNotMatch(container.textContent!, /Kunde inte läsa/);
    assert.equal(rowsOf(container).length, 1, "the recording is listed once the store can be read");
  } finally {
    store.listUnsent = listUnsent;
  }
});
