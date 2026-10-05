import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";

import { cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(cleanup);

const settle = (view: { act: (callback: () => Promise<void>) => Promise<void> }) => view.act(async () => new Promise<void>((resolve) => setTimeout(resolve, 30)));

// The process keeps the formatting code once it has loaded, as the page does: this test is first in its file, and the
// only one to see a load fail.
test("when the formatting code cannot be loaded the text stays, with one action: the person's own reload", async (t) => {
  const { Markdown } = await import("../components/flow/Markdown");
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => void process.off("unhandledRejection", onUnhandled));

  // A chunk that cannot be fetched (the page is older than the deploy): the import rejects.
  const path = require.resolve("../components/flow/MarkdownFormatted");
  require.cache[path] = {
    id: path, filename: path, loaded: true, children: [], paths: [], path,
    exports: new Proxy({}, { get: () => { throw new Error("Loading chunk 756 failed."); } }),
  } as unknown as NodeModule;
  t.after(() => void delete require.cache[path]);

  const text = "## Protokoll\n\nKommunstyrelsen **godkänner** förslaget.";
  const view = await mount(createElement("article", null, createElement(Markdown, null, text)));
  await settle(view);
  const article = view.container.querySelector("article")!;
  assert.equal(unhandled.length, 0, "the failure is caught, not left to the page");
  assert.ok(article.textContent?.includes(text), "the text is still there, as written");
  assert.match(article.textContent ?? "", /utan formatering, den kunde inte läsas in\./, "and it says why it is plain");
  assert.deepEqual([...article.querySelectorAll("button")].map((b) => b.textContent?.trim()), ["Ladda om sidan"], "one action, which nothing presses by itself");
  assert.doesNotMatch(article.textContent ?? "", /Det du har skrivit/, "nothing is promised: there is nothing typed in a result's text");
});
