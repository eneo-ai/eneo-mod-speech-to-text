import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";

import fixtures from "../tests/fixtures/speaker_review.json";
import { segmentsFromTranscription } from "./transcript";
import { speakerReviewsFromTranscription } from "./speaker-review";
import { button, cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(cleanup);

const settle = (view: { act: (callback: () => Promise<void>) => Promise<void> }) => view.act(async () => new Promise<void>((resolve) => setTimeout(resolve, 30)));

// The process keeps the editor's code once it has loaded, as the page does: this test is first in its file, and the
// only one to see a load fail.
test("when the editor's code cannot be loaded the transcript says so and a press fetches only that code again", async (t) => {
  const { TranscriptPlayer } = await import("../components/TranscriptPlayer");
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => void process.off("unhandledRejection", onUnhandled));

  // A chunk that cannot be fetched (the page is older than the deploy that replaced its files): the import rejects.
  const path = require.resolve("../components/TranscriptEditor");
  require.cache[path] = {
    id: path, filename: path, loaded: true, children: [], paths: [], path,
    exports: new Proxy({}, { get: () => { throw new Error("Loading chunk 412 failed."); } }),
  } as unknown as NodeModule;
  t.after(() => void delete require.cache[path]);

  const result = fixtures.cases.find((c) => c.name === "clear")!.result;
  const segments = segmentsFromTranscription(result)!;
  const view = await mount(
    createElement(TranscriptPlayer, {
      segments, speakerReviews: speakerReviewsFromTranscription(result), fileCount: 0, audioSrcFor: () => "",
      speakerNames: {}, textFallback: "", reviewEnabled: true,
    }),
  );
  await settle(view);
  const shown = () => view.container.textContent ?? "";
  assert.equal(unhandled.length, 0, "the failure is caught, not left to the page");
  assert.match(shown(), /Granskningsverktygen kunde inte läsas in\./, "it says why the transcript is not there");
  assert.equal(view.container.querySelector('[aria-busy="true"]'), null, "and is no longer waiting");
  const retry = button(view.container, "Försök igen");
  assert.ok(retry, "a way to try again");
  assert.ok(!shown().includes(segments[0].text), "the editor is not there yet");

  // The chunk can be fetched now: one press loads it, the page is not reloaded.
  delete require.cache[path];
  await view.act(async () => retry.click());
  await settle(view);
  assert.ok(shown().includes(segments[0].text), "the transcript is there");
  assert.equal(button(view.container, "Försök igen"), null, "and nothing is left to retry");
  assert.doesNotMatch(shown(), /kunde inte läsas in/);
  assert.equal(unhandled.length, 0);
});
