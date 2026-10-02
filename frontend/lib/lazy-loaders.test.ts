import assert from "node:assert/strict";
import test, { afterEach, type TestContext } from "node:test";
import { createElement } from "react";

import { button, cleanup, installDom, mount } from "./test-dom";
import type { TranscriptSegment } from "./transcript";

installDom();
afterEach(cleanup);

const settle = (view: { act: (callback: () => Promise<void>) => Promise<void> }, ms = 40) => view.act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** What the page's status lines say, which a screen reader announces. */
const statuses = (within: ParentNode) => [...within.querySelectorAll('[role="status"]')].map((line) => line.textContent).join(" ");

/** A chunk that cannot be fetched, as a tab older than the deploy that replaced its files finds it: the import rejects. */
function refuse(t: TestContext, request: string) {
  const path = require.resolve(request);
  const kept = require.cache[path];
  require.cache[path] = {
    id: path, filename: path, loaded: true, children: [], paths: [], path,
    exports: new Proxy({}, { get: () => { throw new Error("Loading chunk 756 failed."); } }),
  } as unknown as NodeModule;
  const allow = () => {
    if (kept) require.cache[path] = kept;
    else delete require.cache[path];
  };
  t.after(allow);
  return allow;
}

/** A module of its own, as the first load of a page has it: nothing of what it loads lazily is kept yet. */
function fresh<T>(request: string): T {
  const path = require.resolve(request);
  const kept = require.cache[path];
  delete require.cache[path];
  restore = () => void (kept && (require.cache[path] = kept));
  return require(request) as T;
}
let restore = () => {};
afterEach(() => restore());

test("a date field whose calendar cannot be loaded stays a text field with the same label and value, says so, and a press fetches only the calendar", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => void process.off("unhandledRejection", onUnhandled));
  const allow = refuse(t, "@astryxdesign/core/DateInput");
  const { DetailsForm } = fresh<typeof import("../components/flow/DetailsForm")>("../components/flow/DetailsForm");
  const changes: string[] = [];
  const view = await mount(
    createElement(DetailsForm, {
      fields: [{ name: "datum", label: "Datum", type: "date" }],
      details: { datum: "2026-09-24" },
      invalid: [],
      onChange: (name: string, value: unknown) => void changes.push(`${name}=${String(value)}`),
      suggestions: [],
      onNamesAdded: () => {},
    }),
  );
  await settle(view);
  const field = () => view.container.querySelector<HTMLInputElement>('[data-detail-field="datum"]');
  assert.equal(unhandled.length, 0, "the failure is caught, not left to the page");
  assert.equal(field()?.tagName, "INPUT", "a plain field");
  assert.equal(field()?.value, "2026-09-24", "with the value it holds");
  assert.match(view.container.textContent ?? "", /Datum/, "with its label");
  assert.match(statuses(view.container), /Kalendern kunde inte läsas in\./);
  const retry = button(view.container, "Försök igen");
  assert.ok(retry, "a way to try again");

  // The calendar can be fetched now: one press loads it, and the form stays where it is.
  allow();
  await view.act(async () => retry.click());
  await settle(view);
  assert.doesNotMatch(view.container.textContent ?? "", /kunde inte läsas in/, "nothing left to say");
  assert.equal(button(view.container, "Försök igen"), null, "and nothing left to retry");
  assert.match(view.container.textContent ?? "", /Datum/);
  assert.equal(unhandled.length, 0);
  assert.deepEqual(changes, []);
});

test("before the calendar has arrived a date field is a text field with its label and value, the first render's as well as the server's", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { DetailsForm } = fresh<typeof import("../components/flow/DetailsForm")>("../components/flow/DetailsForm");
  const html = renderToStaticMarkup(
    createElement(DetailsForm, {
      fields: [{ name: "datum", label: "Datum", type: "date" }],
      details: { datum: "2026-09-24" },
      invalid: [],
      onChange: () => {},
      suggestions: [],
      onNamesAdded: () => {},
    }),
  );
  assert.match(html, /<label[^>]*>Datum/);
  assert.match(html, /<input[^>]*value="2026-09-24"/);
  assert.doesNotMatch(html, /astryx-date-input/, "no calendar yet");
});

const segments: TranscriptSegment[] = [{ fileIndex: 0, start: 0, end: 2, speaker: "SPEAKER_00", text: "Välkomna till mötet." }];

test("a review editor whose code cannot be loaded says so, and a press fetches only the editor", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => void process.off("unhandledRejection", onUnhandled));
  const allow = refuse(t, "../components/TranscriptEditor");
  const { TranscriptPlayer } = fresh<typeof import("../components/TranscriptPlayer")>("../components/TranscriptPlayer");
  const view = await mount(
    createElement(TranscriptPlayer, { segments, fileCount: 0, audioSrcFor: () => "", speakerNames: {}, textFallback: "", reviewEnabled: true }),
  );
  await settle(view);
  assert.equal(unhandled.length, 0, "the failure is caught, not left to the page");
  assert.match(statuses(view.container), /Granskningsverktygen kunde inte läsas in\./);
  assert.ok(!view.container.querySelector('[aria-busy="true"]'), "it is not still waiting");
  const retry = button(view.container, "Försök igen");
  assert.ok(retry, "a way to try again");

  allow();
  await view.act(async () => retry.click());
  await settle(view, 120);
  assert.equal(button(view.container, "Försök igen"), null, "the editor has arrived");
  assert.doesNotMatch(view.container.textContent ?? "", /kunde inte läsas in/);
  assert.match(view.container.textContent ?? "", /Välkomna till mötet\./, "with the transcript");
  assert.equal(unhandled.length, 0);
});
