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

test("narrower than a laptop, Dokument and Transkript are tabs that keep each other's state", async (t) => {
  const { createElement } = await import("react");
  const { RunResult } = await import("../components/flow/RunResult");
  const original = globalThis.fetch;
  t.after(() => void (globalThis.fetch = original));
  // Word timings: none stored (404); corrections: none saved yet.
  globalThis.fetch = (async (url: string | URL | Request) =>
    String(url).includes("transcript-words")
      ? Response.json({ code: "not_found" }, { status: 404 })
      : Response.json([])) as typeof fetch;
  const transcribe = {
    id: "result-1", step_id: "step-1", step_order: 1, status: "completed",
    input_payload_json: {
      transcription: {
        file_ids: ["file-a"],
        segments: [
          { file_index: 0, start: 0, end: 2, speaker: "SPEAKER_00", text: "Välkomna till mötet." },
          { file_index: 0, start: 2, end: 4, speaker: "SPEAKER_01", text: "Första punkten gäller budgeten." },
        ],
      },
    },
  };
  const view = await mount(
    createElement(RunResult, {
      flowId: "flow-1",
      flowName: "Nämndmöte till rapport",
      run: { id: "run-1", flow_id: "flow-1", status: "completed", revision: 1, finished_at: "2026-09-24T09:02:00Z", result: { kind: "inline_text", text } } as never,
      steps: [],
      stepResults: [transcribe] as never,
      files: [pdf],
      onNewRecording: () => undefined,
      onRegenerated: () => undefined,
    }),
  );
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const tab = (name: string) => [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === name)!;
  assert.equal(tab("Dokument").getAttribute("aria-selected"), "true", "the document first");
  const panels = view.container.querySelectorAll('[role="tabpanel"]');
  assert.equal(panels.length, 2, "both views stay mounted");

  const search = view.container.querySelector<HTMLInputElement>('input[aria-label="Sök i transkriptet"]')!;
  await view.act(async () => tab("Transkript").dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 })));
  const { type } = await import("./test-dom");
  await view.act(async () => type(search, "punkten"));
  await view.act(async () => tab("Dokument").dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 })));
  await view.act(async () => tab("Transkript").dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 })));
  assert.equal(view.container.querySelector<HTMLInputElement>('input[aria-label="Sök i transkriptet"]')!.value, "punkten", "the search is kept");
  assert.equal(view.container.querySelectorAll("audio").length, 1, "one player for the page");
  // Nothing has played: no pause beside the document yet.
  assert.ok(!view.container.querySelector("[data-docked-player] button[aria-label='Pausa uppspelningen']"));
});

test("a failed later save keeps the note that the document is older, and says why a new one waits", async (t) => {
  const { createElement } = await import("react");
  const { RunResult } = await import("../components/flow/RunResult");
  const original = globalThis.fetch;
  t.after(() => void (globalThis.fetch = original));
  const hash = "a".repeat(64);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.includes("transcript-words")) return Response.json({ code: "not_found" }, { status: 404 });
    if (path.includes("transcript-corrections") && init?.method === "PATCH") return Response.json({ code: "internal_error" }, { status: 500 });
    if (path.includes("transcript-corrections")) {
      return Response.json([{ flow_run_id: "run-1", step_id: "step-1", schema_version: 3, segments_hash: hash, occurrences: [], speaker_edits: [], revision: 1, stale: false, updated_at: "2026-09-24T10:00:00Z" }]);
    }
    return Response.json([]);
  }) as typeof fetch;
  const transcribe = {
    id: "result-1", step_id: "step-1", step_order: 1, status: "completed",
    input_payload_json: {
      transcription: {
        file_ids: [],
        segments_hash: hash,
        segments: [
          { file_index: 0, start: 0, end: 2, speaker: "SPEAKER_00", text: "Välkomna till mötet." },
          { file_index: 0, start: 2, end: 4, speaker: "SPEAKER_01", text: "Första punkten gäller budgeten." },
        ],
      },
    },
  };
  const view = await mount(
    createElement(RunResult, {
      flowId: "flow-1",
      flowName: "Nämndmöte till rapport",
      run: { id: "run-1", flow_id: "flow-1", status: "completed", revision: 1, finished_at: "2026-09-24T09:02:00Z", result: { kind: "inline_text", text } } as never,
      steps: [],
      stepResults: [transcribe] as never,
      files: [pdf],
      onNewRecording: () => undefined,
      onRegenerated: () => undefined,
    }),
  );
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const note = () => view.container.querySelector('[role="note"]');
  assert.ok(note(), "saved corrections are newer than the document");
  assert.equal(button(note()!, "Skapa dokumentet igen med rättningarna")!.disabled, false);

  // A later correction fails to save.
  await view.act(async () => button(view.container, "Talare 1, ändra talare")!.click());
  await view.act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[role="radio"][value="SPEAKER_01"]')!.click());
  await view.act(async () => button(document.body, "Spara")!.click());
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.ok(note(), "still said: the document is older than the saved corrections");
  const make = [...note()!.querySelectorAll("button")].find((b) => b.textContent?.includes("Skapa dokumentet igen"))!;
  assert.equal(make.disabled, true, "a new document waits for the failed save");
  assert.match(note()!.textContent ?? "", /inte sparad/);
});
