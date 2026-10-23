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
  parts: [{ index: 0, startedAt, durationMs, bytes: 32_000, chunks: 8, fileId: null }],
  runId: null,
});

const render = ({
  recordings,
  ...props
}: Partial<Omit<ComponentProps<typeof UnsentRecordings>, "list">> & { recordings: UnsentRecording[] }) =>
  mount(createElement(UnsentRecordings, { list: { recordings, unreadable: false, retry: () => {} }, onSend: () => {}, sendLabel: () => "Skapa dokument", ...props }));
/** Each recording: the one that leads the card, then the rows of the list under it. */
const rowsOf = (container: HTMLElement) => [...container.querySelectorAll("[data-recording]")];
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
  assert.equal(recordingDetails(recording("a", 42 * 60_000, at(23, 10, 12)), { withFlowName: true }), "Nämndmöte till rapport · 42\u00a0min");
  assert.equal(recordingDetails(recording("b", 65 * 60_000, at(22, 16, 40))), "1\u00a0h\u00a05\u00a0min");
  const { container } = await render({ recordings: [recording("c", 30_000, at(20, 9, 5)), recording("d", 60_000, at(19, 8, 0))], withFlowName: true });
  const [lead, next] = rowsOf(container);
  // The name the ready panel shows (lib/format recordingName), then its flow and length under the card's heading: the
  // name's date and time whole, the flow's name free to wrap with its dot after it, the length one word; and in the list
  // under it the name over the rest.
  const line = summaryOf(lead).firstElementChild!;
  assert.equal(line.textContent, "Inspelning 20 sep 09:05 · Nämndmöte till rapport\u00a0· 30\u00a0s");
  assert.deepEqual([...line.children].map((part) => part.textContent), ["Inspelning 20 sep 09:05 ·"], "only the name is kept whole");
  assert.deepEqual([...summaryOf(next).children].map((line) => line.textContent), ["Inspelning 19 sep 08:00", "Nämndmöte till rapport · 1\u00a0min"]);
});

test("one unsent recording is spoken of in the singular", async () => {
  const one = await render({ recordings: [recording("a", 60_000, at(23, 10, 12))] });
  assert.equal(one.container.querySelector("h2")?.textContent, "En inspelning har inte skickats");
  assert.match(one.container.textContent!, /Den finns kvar på den här enheten tills den har skickats till Eneo\./);
  await one.unmount();
  const two = await render({ recordings: [recording("a", 60_000, at(23, 10, 12)), recording("b", 60_000, at(23, 9, 0))] });
  assert.equal(two.container.querySelector("h2")?.textContent, "2 inspelningar har inte skickats");
  assert.match(two.container.textContent!, /De finns kvar på den här enheten tills de har skickats till Eneo\./);
});

test("the list says a send goes to Eneo only where a row can send, and that a sent recording cannot go on", async () => {
  const text = async (props: Parameters<typeof render>[0]) => {
    const view = await render(props);
    const words = view.container.textContent!;
    await view.unmount();
    return words;
  };
  const one = recording("a", 60_000, at(23, 10, 12));
  // No send where the flow cannot run, another tab holds the recording, or this browser may only save it.
  for (const props of [
    { recordings: [one], onSend: undefined },
    { recordings: [{ ...one, elsewhere: true }] },
    { recordings: [{ ...one, exportOnly: true }] },
  ]) {
    const words = await text(props);
    assert.match(words, /Den finns kvar på den här enheten tills den har skickats\./);
    assert.doesNotMatch(words, /Eneo/);
  }
  // A recording a reload cut off: going on, or sending, which ends it.
  const cutOff = { ...one, state: "paused" as const };
  assert.match(
    await text({ recordings: [cutOff], onContinue: () => {} }),
    /Den fortsätter i samma inspelning när du väljer Fortsätt spela in\. När den har skickats till Eneo går det inte att fortsätta\./,
  );
  assert.doesNotMatch(await text({ recordings: [cutOff], onContinue: () => {}, onSend: undefined }), /Eneo/);
});

test("where the browser may delete the recordings the list does not promise they stay", async () => {
  const one = await render({ recordings: [recording("a", 60_000, at(23, 10, 12))], evictable: true });
  assert.match(one.container.textContent!, /Den finns på den här enheten\. Webbläsaren kan ta bort den om du väntar länge med att skicka den till Eneo\./);
  assert.doesNotMatch(one.container.textContent!, /tills den har skickats/);
  await one.unmount();
  const two = await render({
    recordings: [recording("a", 60_000, at(23, 10, 12)), recording("b", 60_000, at(23, 9, 0))],
    evictable: true,
  });
  assert.match(two.container.textContent!, /De finns på den här enheten\. Webbläsaren kan ta bort dem om du väntar länge med att skicka dem till Eneo\./);
});

test("a recording the device stopped keeping does not say it is on the device: the latest of it is only in this tab", async () => {
  // The device filled up while it was recorded; the person left the flow page for the list in the same tab.
  const full = await render({ recordings: [{ ...recording("a", 12_000, at(23, 10, 12)), refused: "full" }], evictable: true });
  const said = full.container.textContent!;
  assert.doesNotMatch(said, /finns på den här enheten|finns kvar på den här enheten/, "no word that would make the person close the tab");
  assert.match(said, /Enheten är full, så det senaste av inspelningen finns bara i den här fliken\. Stäng inte fliken\./);
  await full.unmount();
  const refused = await render({ recordings: [{ ...recording("a", 12_000, at(23, 10, 12)), refused: "failed" }] });
  assert.match(refused.container.textContent!, /Det senaste av inspelningen finns bara i den här fliken\. Stäng inte fliken\./);
});

test("among several recordings, each one the device stopped keeping says so in its own row, in view, and none is said to be on the device", async () => {
  // An older recording a reload cut off is kept on the device; a newer one, stopped when the device was full, has its
  // latest audio only in this tab.
  const kept = { ...recording("kept", 60_000, at(23, 9, 0)), state: "recording" as const };
  const tabOnly: UnsentRecording = { ...recording("tab", 12_000, at(23, 10, 12)), refused: "full" };
  for (const folded of [true, false]) {
    const { container, unmount } = await render({ recordings: [tabOnly, kept], onContinue: () => {}, folded });
    assert.doesNotMatch(container.textContent!, /finns (kvar )?på den här enheten/, "no word that would make the person close the tab");
    const fold = container.querySelector("[aria-controls]");
    const hidden = fold && document.getElementById(fold.getAttribute("aria-controls")!);
    const row = rowsOf(container).find((r) => r.textContent!.includes("Inspelning 23 sep 10:12"))!;
    assert.match(row.textContent!, /Enheten är full, så det senaste av inspelningen finns bara i den här fliken\. Stäng inte fliken\./, `folded: ${folded}`);
    assert.ok(!hidden?.contains(row), "not folded away");
    const durable = rowsOf(container).find((r) => r.textContent!.includes("Inspelning 23 sep 09:00"))!;
    assert.doesNotMatch(durable.textContent!, /Stäng inte fliken/, "the recording the device keeps is not said to be in the tab");
    await unmount();
  }
});

test("each unsent recording offers Skapa dokument, Spara ljudfil and Ta bort, described by its summary", async () => {
  const { container } = await render({
    recordings: [recording("a", 60_000, at(23, 10, 12)), recording("b", 120_000, at(23, 9, 0))],
    withFlowName: true,
  });
  const rows = rowsOf(container);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual(labels(row), ["Skapa dokument", "Spara ljudfil", "Ta bort"]);
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
  assert.deepEqual(labels(first), ["Fortsätt spela in", "Skapa dokument", "Spara ljudfil", "Ta bort"]);
  // A recording the person stopped is recorded on in too, as one a reload cut off (until a send of it has begun); sending
  // it is the likelier, so its send comes first and Fortsätt spela in stands with the other ways after it.
  assert.deepEqual(labels(second), ["Skapa dokument", "Fortsätt spela in", "Spara ljudfil", "Ta bort"]);
  await act(async () => button(first, "Fortsätt spela in")!.click());
  await act(async () => button(second, "Skapa dokument")!.click());
  assert.deepEqual([continued, sent], [["a"], ["b"]]);
  const { container: list } = await render({ recordings: [interrupted] });
  assert.equal(button(list, "Fortsätt spela in"), null, "where nothing can take it over (a flow that cannot run now), it is not offered");
});

test("a recording with no audio says so plainly, and offers neither a document nor a file: only going on with it and deleting it", async () => {
  const silent = (id: string, state: "stopped" | "recording") => ({
    ...recording(id, 0, at(23, 10, 12)),
    state,
    parts: [{ index: 0, startedAt: 0, durationMs: 0, bytes: 0, chunks: 0, fileId: null }],
  });
  const { container } = await render({ recordings: [silent("a", "recording"), silent("b", "stopped")], onContinue: () => {} });
  const [cutOff, stopped] = rowsOf(container);
  for (const row of [cutOff, stopped]) assert.match(row.textContent!, /Inget ljud sparades i den här inspelningen\./);
  assert.deepEqual(labels(cutOff), ["Fortsätt spela in", "Ta bort"]);
  assert.deepEqual(labels(stopped), ["Fortsätt spela in", "Ta bort"]);
  const { container: elsewhere } = await render({ recordings: [{ ...silent("c", "stopped"), exportOnly: true }] });
  assert.deepEqual(labels(rowsOf(elsewhere)[0]), [], "another tab's: nothing to save either");
});

test("without Web Locks, another tab's recording is offered only as a file to save, and says why", async () => {
  const elsewhere = { ...recording("a", 60_000, at(23, 10, 12)), state: "paused" as const, exportOnly: true };
  const { container } = await render({ recordings: [elsewhere, recording("b", 60_000, at(23, 9, 0))], onContinue: () => {} });
  const [first, second] = rowsOf(container);
  assert.deepEqual(labels(first), ["Spara ljudfil"]);
  assert.match(first.textContent!, /I den här webbläsaren kan den bara sparas som fil\./);
  assert.equal(summaryOf(first).textContent?.startsWith("Inspelning"), true, "the one action is still described by the summary");
  assert.deepEqual(labels(second), ["Skapa dokument", "Fortsätt spela in", "Spara ljudfil", "Ta bort"], "a recording this tab may change keeps every action");
});

test("a recording a reload cut off says so and how to go on, with Fortsätt spela in the one filled action", async () => {
  const cutOff = (id: string) => ({ ...recording(id, 60_000, at(23, 10, 12)), state: "recording" as const });
  const one = await render({ recordings: [cutOff("a")], onContinue: () => {} });
  assert.equal(one.container.querySelector("h2")?.textContent, "Inspelningen avbröts");
  assert.match(one.container.textContent!, /Den fortsätter i samma inspelning när du väljer Fortsätt spela in\./, "the button by its whole name");
  assert.deepEqual(filled(one.container), ["Fortsätt spela in"]);
  await one.unmount();

  const two = await render({ recordings: [cutOff("a"), cutOff("b")], onContinue: () => {} });
  assert.deepEqual(filled(two.container), ["Fortsätt spela in"], "one filled action, on the first");
  assert.equal(button(rowsOf(two.container)[0], "Fortsätt spela in")?.getAttribute("data-variant"), "primary");
  assert.equal(resumableRecording([recording("c", 60_000, at(23, 9, 0)), cutOff("a"), cutOff("b")])?.id, "a");
  await two.unmount();

  // The flow list offers it too, and goes on in the recording's flow; its rows' actions are all quiet, beside the flows.
  const list = await render({ recordings: [cutOff("a")], withFlowName: true, onContinue: () => {}, filled: false });
  assert.equal(list.container.querySelector("h2")?.textContent, "Inspelningen avbröts");
  assert.ok(button(rowsOf(list.container)[0], "Fortsätt spela in"));
  assert.deepEqual(filled(list.container), []);
  await list.unmount();
  // Where nothing can take it over (a flow that cannot run now), it is one more unsent recording.
  const blocked = await render({ recordings: [cutOff("a")] });
  assert.equal(blocked.container.querySelector("h2")?.textContent, "En inspelning har inte skickats");
  await blocked.unmount();
  const stopped = await render({ recordings: [recording("c", 60_000, at(23, 9, 0))], onContinue: () => {} });
  assert.deepEqual(filled(stopped.container), [], "the setup's own action stays the filled one");
  assert.equal(resumableRecording([{ ...cutOff("a"), exportOnly: true }]), undefined, "another tab's recording is only saved");
});

test("a recording the person stopped can be recorded on in from the list too, beside sending it, which stays the likelier", async () => {
  const stopped = recording("a", 60_000, at(23, 10, 12));
  const { container } = await render({ recordings: [stopped], onContinue: () => {} });
  assert.equal(container.querySelector("h2")?.textContent, "En inspelning har inte skickats", "it was not cut off");
  assert.ok(button(rowsOf(container)[0], "Fortsätt spela in"));
  assert.deepEqual(filled(container), [], "the setup's own action stays the filled one");
  assert.equal(resumableRecording([stopped]), undefined);
  const { container: sent } = await render({ recordings: [{ ...stopped, state: "uploading" }], onContinue: () => {} });
  assert.equal(button(sent, "Fortsätt spela in"), null, "once a send has begun, nothing more is recorded in it");
});

test("folded, the list shows one recording, the latest a reload cut off before the newest, and the rest under a closed fold", async () => {
  const cutOff = (id: string, startedAt: number) => ({ ...recording(id, 60_000, startedAt), state: "recording" as const });
  const newest = recording("new", 60_000, at(23, 11, 0));
  const listed = [newest, cutOff("cut", at(23, 10, 0)), recording("old", 60_000, at(23, 9, 0))];
  const { container } = await render({ recordings: listed, onContinue: () => {}, folded: true });
  assert.equal(container.querySelector("h2")?.textContent, "3 inspelningar har inte skickats");
  const fold = button(container, "2 inspelningar till")!;
  assert.equal(fold.getAttribute("aria-expanded"), "false", "closed until opened");
  const folded = document.getElementById(fold.getAttribute("aria-controls")!)!;
  const shown = rowsOf(container).filter((row) => !folded.contains(row));
  assert.equal(shown.length, 1);
  assert.ok(button(shown[0], "Fortsätt spela in"), "the one to go on with stands in view");
  assert.equal(rowsOf(folded).length, 2);

  const { container: none } = await render({ recordings: [newest, recording("old", 60_000, at(23, 9, 0))], onContinue: () => {}, folded: true });
  const [first] = rowsOf(none);
  assert.match(first.textContent!, /Inspelning 23 sep 11:00/, "without one cut off, the newest");
  assert.deepEqual(labels(first), ["Skapa dokument", "Fortsätt spela in", "Spara ljudfil", "Ta bort"]);
  assert.deepEqual(filled(none), ["Skapa dokument"], "a stopped one is likelier sent than recorded on in: its send is the filled action");
  assert.ok(button(none, "En inspelning till"));
  const { container: page } = await render({ recordings: listed, onContinue: () => {} });
  assert.equal(button(page, "2 inspelningar till"), null, "on a flow's page every one is in view");
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
  assert.deepEqual(labels(row), ["Skapa dokument", "Spara ljudfil", "Ta bort"]);
  assert.equal(focused(), "Ta bort");
});

test("a removed recording is said gone, and the focus goes to the list's heading, saying what is left, or with none left to the page's", async (t) => {
  const store = await import("./recording-store");
  t.mock.method(store, "recordingStore", async () => ({ remove: async () => {} }));
  // The page around the list, as the flow list has it; the list itself is the device's, read again after a removal.
  const page = (recordings: UnsentRecording[]) =>
    createElement(
      "main",
      null,
      createElement("h1", null, "Välj ett flöde"),
      createElement(UnsentRecordings, { list: { recordings, unreadable: false, retry: () => {} }, onSend: () => {}, sendLabel: () => "Skapa dokument" }),
    );
  const first = recording("a", 60_000, at(23, 10, 12));
  const second = recording("b", 60_000, at(23, 9, 0));
  const view = await mount(page([first, second]));
  const remove = async () => {
    const row = rowsOf(view.container)[0];
    await view.act(async () => button(row, "Ta bort")!.click());
    await view.act(async () => button(row.querySelector('[role="group"]')!, "Ta bort")!.click());
  };
  const said = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50)); // the announcer speaks in the next frame
    return document.querySelector('[data-astryx-live-region="polite"]')?.textContent;
  };

  await remove();
  await view.act(async () => view.rerender(page([second])));
  const focused = () => [document.activeElement?.tagName, document.activeElement?.textContent];
  assert.deepEqual(focused(), ["H2", "En inspelning har inte skickats"], "the list's heading, with what is left");
  assert.equal(await said(), "Inspelningen togs bort.");

  await remove();
  await view.act(async () => view.rerender(page([])));
  assert.deepEqual(focused(), ["H1", "Välj ett flöde"], "with none left, the page's heading");
  await view.unmount();
});

test("a recording that cannot be saved or removed says so in an alert, and a removal that failed closes the question", async (t) => {
  const store = await import("./recording-store");
  const { container, act } = await render({ recordings: [recording("a", 60_000, at(23, 10, 12))] });
  const row = rowsOf(container)[0];
  const alert = () => [...row.querySelectorAll('[role="alert"]')].map((a) => a.textContent?.trim());
  assert.deepEqual(alert(), [], "nothing is said before something fails");

  // The device reads nothing back, and refuses the deletion: another tab holds the recording.
  t.mock.method(store, "recordingStore", async () => ({
    readFile: async () => {
      throw new Error("disk");
    },
    remove: async () => {
      throw new Error(IN_USE_ELSEWHERE);
    },
  }));
  await act(async () => button(row, "Spara ljudfil")!.click());
  assert.deepEqual(alert(), ["Inspelningen kunde inte sparas som fil. Försök igen."]);

  await act(async () => button(row, "Ta bort")!.click());
  await act(async () => button(row.querySelector('[role="group"]')!, "Ta bort")!.click());
  assert.deepEqual(alert(), [IN_USE_ELSEWHERE]);
  assert.equal(row.querySelector('[role="group"]'), null, "the question is closed");
  assert.equal(focused(), "Ta bort", "and the focus is back where it was");
});

test("a recording another tab holds is listed with why nothing can be done with it here, and the list is read again when the page is back in view", async () => {
  const { useUnsentRecordings } = await import("../components/UnsentRecordings");
  const { recordingStore } = await import("./recording-store");
  const store = await recordingStore();
  const { listUnsentGroups, mayChange } = store;
  const mine = recording("a", 60_000, at(23, 10, 12));
  const recordedElsewhere = { ...recording("b", 60_000, at(23, 11, 0)), state: "recording" as const };
  let elsewhere = [recordedElsewhere];
  let offered = [mine];
  store.listUnsentGroups = async () => ({ offered, elsewhere });
  store.mayChange = () => true;
  function Unsent() {
    return createElement(UnsentRecordings, { list: useUnsentRecordings("user-1"), onSend: () => {}, onContinue: () => {}, sendLabel: () => "Skapa dokument" });
  }
  try {
    const { container, act } = await mount(createElement(Unsent));
    await act(async () => undefined);
    assert.equal(container.querySelector("h2")?.textContent, "2 inspelningar har inte skickats");
    const [held, own] = rowsOf(container);
    assert.match(held.textContent!, /Inspelningen används i en annan flik\./);
    assert.deepEqual(labels(held), [], "nothing here that the other tab would have to undo");
    assert.deepEqual(labels(own), ["Skapa dokument", "Fortsätt spela in", "Spara ljudfil", "Ta bort"]);

    // The other tab lets it go, which tells this one nothing: back in view, the list is read again.
    elsewhere = [];
    offered = [recordedElsewhere, mine];
    await act(async () => void document.dispatchEvent(new window.Event("visibilitychange")));
    await act(async () => undefined);
    assert.deepEqual(labels(rowsOf(container)[0]), ["Fortsätt spela in", "Skapa dokument", "Spara ljudfil", "Ta bort"]);
  } finally {
    store.listUnsentGroups = listUnsentGroups;
    store.mayChange = mayChange;
  }
});

test("recordings the device's store cannot list are not passed over: a notice stands in the list's place, and Försök igen reads again", async () => {
  const { useUnsentRecordings } = await import("../components/UnsentRecordings");
  const { recordingStore } = await import("./recording-store");
  const store = await recordingStore();
  const listUnsentGroups = store.listUnsentGroups;
  let readable = false;
  store.listUnsentGroups = async () => {
    if (!readable) throw new Error("the database is not readable");
    return { offered: [recording("a", 60_000, at(23, 10, 12))], elsewhere: [] };
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
    store.listUnsentGroups = listUnsentGroups;
  }
});
