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
  stepId: "step-2",
};
const text = "## Protokoll\n\nKommunstyrelsen godkänner förslaget.";

async function document_(props: { text: string | null; file: ResultFileView | null; preview?: string | null }) {
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
  // The file row names the file, and the name opens it; it never offers the same download again.
  const inline = "/api/eneo/flows/flow-1/runs/run-1/artifacts/file-1/content?disposition=inline";
  const name = withFile.container.querySelector<HTMLAnchorElement>(`[data-file-row] a[href="${inline}"]`);
  assert.ok(name, "the file's name is a link to the file");
  assert.equal(name.target, "_blank", "as Öppna PDF: in a new tab");
  assert.equal(name.textContent, `Öppna ${pdf.name} i en ny flik`);
  const row = name.closest("[data-file-row]")!;
  assert.match(row.textContent ?? "", /PDF, 47,1\u00a0kB/);
  assert.ok(!row.querySelector("a[download]"), "no second download in the file row");
  // From a laptop's width the name opens the preview instead; no Öppna beside it does the same again.
  const controls = [...row.querySelectorAll("a, button")].map((el) => el.textContent);
  assert.deepEqual(controls, [`Öppna ${pdf.name} i en ny flik`, `Öppna ${pdf.name}`]);
  assert.equal(row.querySelector("button")!.getAttribute("aria-haspopup"), "dialog");
  await withFile.unmount();

  const textOnly = await document_({ text, file: null });
  assert.deepEqual(filled(textOnly.container), ["Kopiera texten"]);
  await textOnly.unmount();
});

test("the result's own headings sit under the page's h1: its top heading is an h2 whatever its Markdown level", async () => {
  const outline = async (text: string) => {
    const view = await document_({ text, file: null });
    const headings = [...view.container.querySelectorAll("article :is(h1, h2, h3, h4, h5, h6)")].map((h) => `${h.tagName} ${h.textContent}`);
    assert.ok(![...view.container.querySelectorAll("article *")].some((el) => el.hasAttribute("node")), "no markdown internals on the page");
    await view.unmount();
    return headings;
  };
  assert.deepEqual(await outline("# Protokoll\n\n## Beslut\n\n###### Bilaga\n\nText."), ["H2 Protokoll", "H3 Beslut", "H6 Bilaga"]);
  // An underlined title is a heading like any other: here the top one.
  assert.deepEqual(await outline("Protokoll\n=========\n\n## Beslut\n\nText."), ["H2 Protokoll", "H3 Beslut"]);
  assert.deepEqual(await outline("Protokoll\n---------\n\nText."), ["H2 Protokoll"]);
  // A code block holds no headings, whatever its fence and whatever it contains.
  assert.deepEqual(
    await outline("## Protokoll\n\n### Beslut\n\n````md\n```\n# inte en rubrik\n```\n````\n\nText."),
    ["H2 Protokoll", "H3 Beslut"],
  );
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
  // Tab never enters the browser's PDF frame, which keeps Escape and shows no focus; "Öppna i ny flik" reads it.
  assert.equal(dialog.querySelector("iframe")!.tabIndex, -1, "the viewer is not a Tab stop");
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
  // A panel taller than the screen cannot show its focus; each starts with its own controls, so Tab goes there.
  assert.deepEqual([...panels].map((p) => p.getAttribute("tabindex")), [null, null], "the panels are not tab stops");

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

test("Dela reads a file ahead only when its size is known and under the cap, and stops reading when the page goes", async (t) => {
  const realFetch = globalThis.fetch;
  const fetched: { url: string; signal?: AbortSignal | null }[] = [];
  const shared: ShareData[] = [];
  Object.defineProperty(navigator, "share", { value: async (data: ShareData) => void shared.push(data), configurable: true });
  Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    fetched.push({ url: String(url), signal: init?.signal });
    return new Promise<Response>(() => undefined); // a large file still arriving
  }) as typeof fetch;
  t.after(() => {
    Reflect.deleteProperty(navigator, "share");
    Reflect.deleteProperty(navigator, "canShare");
    globalThis.fetch = realFetch;
  });

  // Size unknown: nothing is read ahead; Dela shares the text.
  const unknown = await document_({ text, file: { ...pdf, sizeBytes: null } });
  await unknown.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(fetched.length, 0, "no read ahead of a file of unknown size");
  const more = [...unknown.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Fler alternativ")!;
  await unknown.act(async () => more.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const dela = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === "Dela")!;
  await unknown.act(async () => dela.click());
  assert.equal(shared[0]?.text, text, "the text is shared instead");
  await unknown.unmount();

  // Size known and small: read ahead, and the read stops when the document leaves the page.
  const known = await document_({ text, file: pdf });
  await known.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(fetched.length, 1);
  await known.unmount();
  assert.equal(fetched[0].signal?.aborted, true, "the read ahead is cancelled");
});

test("crossing the laptop breakpoint keeps an unfinished correction and its draft", async (t) => {
  const { createElement } = await import("react");
  const { RunResult } = await import("../components/flow/RunResult");
  const { type } = await import("./test-dom");
  const original = globalThis.fetch;
  const realMatchMedia = window.matchMedia;
  // A window that can be widened past 1024 px, telling whoever listens.
  let wide = false;
  const listeners = new Set<() => void>();
  const matchMedia = (query: string) => ({
    get matches() { return query.includes("min-width: 1024px") ? wide : false; },
    media: query, onchange: null, dispatchEvent: () => false, addListener() {}, removeListener() {},
    addEventListener: (_: string, cb: () => void) => void listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => void listeners.delete(cb),
  });
  Object.defineProperty(window, "matchMedia", { value: matchMedia, configurable: true, writable: true });
  t.after(() => {
    globalThis.fetch = original;
    Object.defineProperty(window, "matchMedia", { value: realMatchMedia, configurable: true, writable: true });
  });
  globalThis.fetch = (async (url: string | URL | Request) =>
    String(url).includes("transcript-words") ? Response.json({ code: "not_found" }, { status: 404 }) : Response.json([])) as typeof fetch;
  const transcribe = {
    id: "result-1", step_id: "step-1", step_order: 1, status: "completed",
    input_payload_json: { transcription: { file_ids: [], segments: [
      { file_index: 0, start: 0, end: 2, speaker: "SPEAKER_00", text: "Välkomna till mötet." },
      { file_index: 0, start: 2, end: 4, speaker: "SPEAKER_01", text: "Första punkten." },
    ] } },
  };
  const view = await mount(
    createElement(RunResult, {
      flowId: "flow-1", flowName: "Nämndmöte till rapport",
      run: { id: "run-1", flow_id: "flow-1", status: "completed", revision: 1, finished_at: "2026-09-24T09:02:00Z", result: { kind: "inline_text", text } } as never,
      steps: [], stepResults: [transcribe] as never, files: [pdf],
      onNewRecording: () => undefined, onRegenerated: () => undefined,
    }),
  );
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  await view.act(async () => button(view.container, "Rätta repliken från 0:00")!.click());
  await view.act(async () => type(view.container.querySelector("textarea")!, "Välkomna allihop."));
  wide = true;
  await view.act(async () => listeners.forEach((listener) => listener()));
  assert.ok(!view.container.querySelector('[role="tablist"]'), "side by side now");
  assert.equal(view.container.querySelector("textarea")?.value, "Välkomna allihop.", "the draft is still being written");
});

test("a file whose link only its owner's session opens is never shared as a link: no Dela without text", async (t) => {
  const realFetch = globalThis.fetch;
  Object.defineProperty(navigator, "share", { value: async () => undefined, configurable: true });
  Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
  globalThis.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
  t.after(() => {
    Reflect.deleteProperty(navigator, "share");
    Reflect.deleteProperty(navigator, "canShare");
    globalThis.fetch = realFetch;
  });
  const view = await document_({ text: null, file: { ...pdf, sizeBytes: null } });
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.ok(
    ![...view.container.querySelectorAll("button")].some((b) => b.getAttribute("aria-label") === "Fler alternativ"),
    "nothing to share: no menu, no Dela",
  );
  assert.ok(view.container.querySelector("a[download]"), "Ladda ner stays");
});

/** The preview of the file's text: the region its caption names. */
const previewOf = (within: ParentNode) =>
  [...within.querySelectorAll<HTMLElement>("section[aria-labelledby]")].find(
    (section) => document.getElementById(section.getAttribute("aria-labelledby")!)?.textContent === "Förhandsvisning av texten i filen",
  ) ?? null;
const headingsIn = (within: ParentNode) =>
  [...within.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => `${h.tagName} ${h.textContent}`);

test("a document that is only its file shows the file's text under the file, as a preview", async () => {
  const view = await document_({ text: null, file: pdf, preview: text });
  const preview = previewOf(view.container);
  assert.ok(preview, "a preview, named as one");
  const row = view.container.querySelector("[data-file-row]")!;
  assert.ok(row.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING, "under the file, which stays the document");
  assert.deepEqual(headingsIn(preview), ["H2 Protokoll"], "its headings under the page's h1");
  assert.match(preview.textContent ?? "", /Kommunstyrelsen godkänner förslaget\./);
  assert.ok(!preview.querySelector("button"), "short: no Visa hela texten, and no second Kopiera");
  await view.unmount();

  const none = await document_({ text: null, file: pdf, preview: null });
  assert.equal(previewOf(none.container), null, "no reliable text: no empty box");
});

test("a long file text shows its first part until Visa hela texten, a disclosure that says what it opens", async () => {
  const point = (n: number) => `### Punkt ${n}\n\n${"Nämnden diskuterade ärendet och beslutade enligt förslaget. ".repeat(3)}`;
  // A fenced block keeps its blank lines: the first part never ends inside it.
  const code = "```\n" + "rad\n\n".repeat(200) + "sista raden\n```";
  const long = ["## Protokoll", code, ...Array.from({ length: 12 }, (_, i) => point(i + 1))].join("\n\n");
  const view = await document_({ text: null, file: pdf, preview: long });
  const preview = previewOf(view.container)!;
  const more = button(preview, "Visa hela texten")!;
  assert.ok(more, "Visa hela texten");
  assert.equal(more.getAttribute("aria-expanded"), "false");
  const article = document.getElementById(more.getAttribute("aria-controls")!)!;
  assert.ok(preview.contains(article), "it controls the text it opens");
  assert.match(article.querySelector("pre")?.textContent ?? "", /sista raden/);
  const shown = headingsIn(article);
  assert.equal(shown[0], "H2 Protokoll");
  assert.ok(shown.length < 13 && !shown.includes("H3 Punkt 12"), `only the first part: ${shown}`);

  await view.act(async () => more.click());
  assert.equal(more.getAttribute("aria-expanded"), "true");
  assert.equal(more.textContent, "Visa mindre");
  assert.deepEqual(headingsIn(article), ["H2 Protokoll", ...Array.from({ length: 12 }, (_, i) => `H3 Punkt ${i + 1}`)]);

  await view.act(async () => more.click());
  assert.ok(!headingsIn(article).includes("H3 Punkt 12"), "folded again");
});

test("a finished run whose document is only its file previews the text its own step laid out in it", async (t) => {
  const { createElement } = await import("react");
  const { RunResult } = await import("../components/flow/RunResult");
  const original = globalThis.fetch;
  t.after(() => void (globalThis.fetch = original));
  globalThis.fetch = (async () => Response.json([])) as typeof fetch;
  const view = await mount(
    createElement(RunResult, {
      flowId: "flow-1",
      flowName: "Nämndmöte till rapport",
      run: { id: "run-1", flow_id: "flow-1", status: "completed", revision: 1, finished_at: "2026-09-24T09:02:00Z", result: { kind: "artifact", files: [] } } as never,
      steps: [],
      stepResults: [
        { id: "result-1", step_id: "step-1", status: "completed", output_payload_json: { text: "Välkomna till mötet." } },
        { id: "result-2", step_id: "step-2", status: "completed", model_parameters_json: { model_id: "model-1" }, output_payload_json: { text } },
      ] as never,
      files: [pdf],
      showTranscript: false,
      onNewRecording: () => undefined,
      onRegenerated: () => undefined,
    }),
  );
  const preview = previewOf(view.container);
  assert.ok(preview, "the file's text under it");
  assert.match(preview.textContent ?? "", /Kommunstyrelsen godkänner förslaget\./);
  assert.doesNotMatch(preview.textContent ?? "", /Välkomna/, "not the transcript the step read");
});

test("a flow that makes text says the text is ready, and offers to make the text again", async (t) => {
  const { createElement } = await import("react");
  const { RunResult } = await import("../components/flow/RunResult");
  const original = globalThis.fetch;
  t.after(() => void (globalThis.fetch = original));
  const hash = "b".repeat(64);
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path.includes("transcript-words")) return Response.json({ code: "not_found" }, { status: 404 });
    if (path.includes("transcript-corrections")) {
      return Response.json([{ flow_run_id: "run-1", step_id: "step-1", schema_version: 3, segments_hash: hash, occurrences: [], speaker_edits: [], revision: 1, stale: false, updated_at: "2026-09-24T10:00:00Z" }]);
    }
    return Response.json([]);
  }) as typeof fetch;
  const transcribe = {
    id: "result-1", step_id: "step-1", step_order: 1, status: "completed",
    input_payload_json: { transcription: { file_ids: [], segments_hash: hash, segments: [
      { file_index: 0, start: 0, end: 2, speaker: "SPEAKER_00", text: "Välkomna till mötet." },
    ] } },
  };
  const view = await mount(
    createElement(RunResult, {
      flowId: "flow-1",
      flowName: "Intervju till sammanfattning",
      run: { id: "run-1", flow_id: "flow-1", flow_version: 7, status: "completed", revision: 1, finished_at: "2026-09-24T09:02:00Z", result: { kind: "inline_text", text } } as never,
      contract: { flow_id: "flow-1", published_flow_version: 7, final_output: { output_type: "text", delivery: "payload" } },
      steps: [],
      stepResults: [transcribe] as never,
      files: [],
      onNewRecording: () => undefined,
      onRegenerated: () => undefined,
    }),
  );
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(view.container.querySelector("h1")?.textContent, "Texten är klar");
  const note = view.container.querySelector('[role="note"]')!;
  assert.match(note.textContent ?? "", /^Texten skapades före dina rättningar/);
  assert.ok(button(note, "Skapa texten igen med rättningarna"), "Skapa texten igen");
  assert.deepEqual([...view.container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent), ["Text", "Transkript"]);
  assert.ok(view.container.querySelector('section[aria-label="Texten"]'), "the text, named as such");
  assert.doesNotMatch(view.container.textContent ?? "", /[Dd]okument/);
});

test("a flow that makes text that failed says the text could not be made", async () => {
  const { createElement } = await import("react");
  const { RunFailure } = await import("../components/flow/RunFailure");
  const failure = { step: null, summary: "Körningen kunde inte slutföras.", detail: "x", inputMustChange: false };
  const heading = async (output_type: string, delivery: "payload" | "artifact" | "outbound_http") => {
    const view = await mount(
      createElement(RunFailure, {
        flowId: "flow-1", flowName: "Intervju till sammanfattning",
        run: { id: "run-1", flow_id: "flow-1", flow_version: 7, status: "failed" } as never,
        contract: { flow_id: "flow-1", published_flow_version: 7, final_output: { output_type, delivery } },
        failure, steps: [], stepResults: [], files: [],
      }),
    );
    const h1 = view.container.querySelector("h1")?.textContent;
    await view.unmount();
    return h1;
  };
  assert.equal(await heading("json", "payload"), "Texten kunde inte skapas");
  assert.equal(await heading("pdf", "artifact"), "Dokumentet kunde inte skapas");
  // A flow that sends its JSON on makes no text to show: it reads as before.
  assert.equal(await heading("json", "outbound_http"), "Dokumentet kunde inte skapas");
});
