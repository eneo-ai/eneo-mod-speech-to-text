import assert from "node:assert/strict";
import test, { afterEach, type TestContext } from "node:test";
import { createElement } from "react";

import { cleanup, installDom, mount } from "./test-dom";
import type { TranscriptSegment } from "./transcript";

installDom();
afterEach(cleanup);

const settle = (view: { act: (callback: () => Promise<void>) => Promise<void> }, ms = 40) => view.act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** What the page's status lines say, which a screen reader announces. */
const statuses = (within: ParentNode) =>
  [...within.querySelectorAll('[role="status"]')].map((line) => line.textContent?.trim()).filter(Boolean).join(" ");

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

test("a date field whose calendar cannot be loaded stays a text field with the same label and value, says so, and offers the person's own reload", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => void process.off("unhandledRejection", onUnhandled));
  refuse(t, "@astryxdesign/core/DateInput");
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
  assert.equal(statuses(view.container), "Kalendern kunde inte läsas in. Det du har skrivit finns kvar.", "what the details draft keeps through a reload");
  assert.deepEqual([...view.container.querySelectorAll("button")].map((b) => b.textContent?.trim()), ["Ladda om sidan"], "one action, which nothing presses by itself");
  assert.equal(unhandled.length, 0);
  assert.deepEqual(changes, []);
});

test("before the calendar has arrived a date field is a text field with its label and value", async () => {
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

test("a review editor whose code cannot be loaded says so, and offers the person's own reload", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => void process.off("unhandledRejection", onUnhandled));
  refuse(t, "../components/TranscriptEditor");
  const { TranscriptPlayer } = fresh<typeof import("../components/TranscriptPlayer")>("../components/TranscriptPlayer");
  const view = await mount(
    createElement(TranscriptPlayer, { segments, fileCount: 0, audioSrcFor: () => "", speakerNames: {}, textFallback: "", reviewEnabled: true }),
  );
  await settle(view);
  assert.equal(unhandled.length, 0, "the failure is caught, not left to the page");
  assert.equal(statuses(view.container), "Granskningsverktygen kunde inte läsas in. Det du har skrivit finns kvar.", "what the review's draft keeps through a reload");
  assert.ok(!view.container.querySelector('[aria-busy="true"]'), "it is not still waiting");
  assert.deepEqual([...view.container.querySelectorAll("button")].map((b) => b.textContent?.trim()).filter((label) => label === "Ladda om sidan"), ["Ladda om sidan"], "one action");
  assert.doesNotMatch(view.container.textContent ?? "", /Försök igen/);
  assert.equal(unhandled.length, 0);
});
