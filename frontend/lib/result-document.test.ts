import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { button, cleanup, installDom, mount } from "./test-dom";
import type { ResultFileView } from "./run-files";

installDom();
afterEach(cleanup);

const pdf: ResultFileView = {
  fileId: "file-1",
  name: "Protokoll kommunstyrelsen 2026-09-24.pdf",
  kind: "pdf",
  typeLabel: "PDF",
  mimeType: "application/pdf",
  sizeBytes: 48_213,
  meta: "PDF, 47,1 kB",
  available: true,
  previewable: true,
};
const text = "## Protokoll\n\nKommunstyrelsen godkänner förslaget.";

async function document_(props: { text: string | null; file: ResultFileView | null }) {
  const { createElement } = await import("react");
  const { ResultDocument } = await import("../components/flow/ResultDocument");
  return mount(createElement(ResultDocument, { flowId: "flow-1", runId: "run-1", title: "Nämndmöte till rapport", ...props }));
}

/** The distinct filled actions (the wide and the narrow bar each show one): the primary variant, on a button or a link. */
const filled = (within: ParentNode) => [
  ...new Set(
    [...within.querySelectorAll<HTMLElement>("a, button")]
      .filter((el) => /(^| )bg-primary( |$)/.test(el.className))
      .map((el) => el.textContent?.trim()),
  ),
];

test("the document's one filled action is its file's download; without a file it is copying the text", async () => {
  const withFile = await document_({ text, file: pdf });
  assert.deepEqual(filled(withFile.container), ["Ladda ner PDF, Protokoll kommunstyrelsen 2026-09-24.pdf"]);
  // The file row names the file and opens it; it never offers the same download again.
  const row = [...withFile.container.querySelectorAll("p")].find((p) => p.textContent === pdf.name)!.closest("div.flex")!;
  assert.match(row.textContent ?? "", /PDF, 47,1\u00a0kB/);
  assert.ok(!row.querySelector("a[download]"), "no second download in the file row");
  assert.ok([...row.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Öppna")), "Öppna in the file row");
  await withFile.unmount();

  const textOnly = await document_({ text, file: null });
  assert.deepEqual(filled(textOnly.container), ["Kopiera texten"]);
  await textOnly.unmount();
});

test("on a narrower screen Kopiera texten sits under Fler alternativ, a labelled menu", async () => {
  const view = await document_({ text, file: pdf });
  const more = [...view.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Fler alternativ")!;
  await view.act(async () => more.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim());
  assert.deepEqual(items, ["Kopiera texten"], "no Dela without a share sheet");
});

test("Dela only where the browser can share, and then the file itself when the device takes its type", async () => {
  const without = await document_({ text: null, file: pdf });
  assert.ok(![...without.container.querySelectorAll("button")].some((b) => b.getAttribute("aria-label") === "Fler alternativ"), "nothing more to offer, no menu");
  await without.unmount();

  const shared: ShareData[] = [];
  const realFetch = globalThis.fetch;
  Object.defineProperty(navigator, "share", { value: async (data: ShareData) => void shared.push(data), configurable: true });
  Object.defineProperty(navigator, "canShare", {
    value: (data: ShareData) => Boolean(data.files?.every((f) => f.type === "application/pdf")),
    configurable: true,
  });
  globalThis.fetch = (async () => new Response(new Blob(["%PDF"], { type: "application/pdf" }))) as typeof fetch;
  try {
    const view = await document_({ text, file: pdf });
    await view.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const more = [...view.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Fler alternativ")!;
    await view.act(async () => more.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const dela = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === "Dela")!;
    assert.ok(dela, "Dela appears");
    await view.act(async () => dela.click());
    assert.equal(shared.length, 1);
    assert.equal(shared[0].files?.[0].name, "Protokoll kommunstyrelsen 2026-09-24.pdf");
    assert.equal(shared[0].title, "Nämndmöte till rapport");
  } finally {
    Reflect.deleteProperty(navigator, "share");
    Reflect.deleteProperty(navigator, "canShare");
    globalThis.fetch = realFetch;
  }
});

test("the PDF opens on its title, with its actions and Stäng before the viewer", async () => {
  const { createElement } = await import("react");
  const { ResultFiles } = await import("../components/flow/ResultFiles");
  const view = await mount(createElement(ResultFiles, { flowId: "flow-1", runId: "run-1", files: [pdf] }));
  const open = [...view.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-haspopup") === "dialog")!;
  await view.act(async () => open.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  assert.equal(document.activeElement?.textContent, pdf.name, "focus on the title, not in the viewer");
  const order = [...dialog.querySelectorAll("button, a, iframe")].map((el) => el.tagName === "IFRAME" ? "viewer" : el.textContent?.trim());
  assert.deepEqual(order, ["Öppna i ny flik", "Ladda ner", "Stäng", "viewer"]);
});
