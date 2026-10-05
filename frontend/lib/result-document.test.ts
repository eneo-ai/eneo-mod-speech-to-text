import assert from "node:assert/strict";
import test, { afterEach, type TestContext } from "node:test";
import type { ReactElement } from "react";

import { asPerson, button, cleanup, installDom, mount } from "./test-dom";
import { withRouter } from "./test-router";
import type { ResultFileView } from "./run-files";

installDom();
afterEach(cleanup);

/** What a page is rendered in: the design system's providers, so its own words are Swedish ("Stäng"). */
async function inProviders(element: ReactElement) {
  const { createElement } = await import("react");
  const { ModuleProviders } = await import("@/kit/ModuleProviders");
  return mount(createElement(ModuleProviders, null, element));
}

/** A window this many pixels wide, as far as `(min-width: …px)` can tell; a phone's by default (the test document's). */
function widthOf(t: TestContext, pixels: number) {
  const real = window.matchMedia;
  let current = pixels;
  const listeners = new Set<() => void>();
  const matchMedia = (query: string) => ({
    get matches() {
      return current >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity);
    },
    media: query, onchange: null, dispatchEvent: () => false, addListener() {}, removeListener() {},
    addEventListener: (_: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => void listeners.delete(listener),
  });
  Object.defineProperty(window, "matchMedia", { value: matchMedia, configurable: true, writable: true });
  t.after(() => void Object.defineProperty(window, "matchMedia", { value: real, configurable: true, writable: true }));
  /** The window is resized to this width, telling whoever listens (run it inside the view's `act`). */
  return (next: number) => {
    current = next;
    listeners.forEach((listener) => listener());
  };
}

// What the module answers for a run's file when a person asks for it: the first byte, or why not.
const INLINE = "/api/eneo/flows/flow-1/runs/run-1/artifacts/file-1/content?disposition=inline";
const ATTACHMENT = "/api/eneo/flows/flow-1/runs/run-1/artifacts/file-1/content?disposition=attachment";
const present = () => new Response("%", { status: 206, headers: { "content-type": "application/pdf" } });
const missing = () => Response.json({ detail: "File not found" }, { status: 404 });

function filesAnswer(t: TestContext, answer: () => Response) {
  const asked: { url: string; range: string | null }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), range: new Headers(init?.headers).get("Range") });
    return answer();
  }) as typeof fetch;
  t.after(() => void (globalThis.fetch = real));
  return asked;
}

/** Presses a link as a person does, so the page's own handler runs and what a link would do is up to it. */
const press = (link: Element) => link.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));

/** The downloads the page starts, by the link it makes for each. */
function downloads(t: TestContext) {
  const started: string[] = [];
  t.mock.method(window.HTMLAnchorElement.prototype, "click", function (this: HTMLAnchorElement) {
    started.push(`${this.getAttribute("href")}${this.hasAttribute("download") ? " (download)" : ""}`);
  });
  return started;
}

/** The tabs the page opens: blank at first, so that the press itself opens it, and sent to the file when it is there. */
function tabs(t: TestContext) {
  const opened: { url: string; opener: unknown; closed: boolean; location: { replace(to: string): void }; close(): void }[] = [];
  const real = window.open;
  window.open = ((url?: string | URL) => {
    const tab = {
      url: String(url ?? ""),
      opener: {} as unknown,
      closed: false,
      location: { replace: (to: string) => void (tab.url = to) },
      close: () => void (tab.closed = true),
    };
    opened.push(tab);
    return tab;
  }) as unknown as typeof window.open;
  t.after(() => void (window.open = real));
  return opened;
}

const alertsOf = (within: ParentNode) => [...within.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent);

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

/** Until the code that formats Markdown has arrived (Markdown.tsx): the page is read after it has. */
const formatted = (view: { act: (callback: () => Promise<void>) => Promise<void> }) => view.act(async () => new Promise<void>((resolve) => setTimeout(resolve, 20)));

async function document_(props: { text: string | null; file: ResultFileView | null; preview?: string | null }) {
  const { createElement } = await import("react");
  const { ResultDocument } = await import("../components/flow/ResultDocument");
  const view = await inProviders(createElement(ResultDocument, { flowId: "flow-1", runId: "run-1", title: "Nämndmöte till rapport", ...props }));
  await formatted(view);
  return view;
}

/** What a screen reader hears from a control: the label the design system sets where the words say less, else the words. */
const nameOf = (el: Element) => el.getAttribute("aria-label") ?? el.textContent?.trim();

/** The words of a tab. The design system draws a tab's label twice, the second one hidden (it keeps the tab's width when chosen). */
const tabLabel = (tab: Element) => tab.querySelector("span > span:not([aria-hidden])")?.textContent;
const tabsIn = (within: ParentNode) => [...within.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

/** The distinct filled actions: the primary variant, on a button or a link. */
const filled = (within: ParentNode) => [
  ...new Set(
    [...within.querySelectorAll<HTMLElement>("a, button")].filter((el) => el.getAttribute("data-variant") === "primary").map(nameOf),
  ),
];

test("a document's text is there as it was written until the code that formats it has arrived, and is formatted then", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ResultDocument } = await import("../components/flow/ResultDocument");
  const props = { flowId: "flow-1", runId: "run-1", title: "Nämndmöte till rapport", text, file: null };
  // The first render: the formatting code is not there yet.
  const before = renderToStaticMarkup(createElement(ResultDocument, props));
  assert.match(before, /## Protokoll\n\nKommunstyrelsen godkänner förslaget\./, "the text as written, nothing missing");
  assert.doesNotMatch(before, /<h2/, "not formatted yet");

  const view = await inProviders(createElement(ResultDocument, props));
  await formatted(view);
  const article = view.container.querySelector("article")!;
  assert.deepEqual([...article.querySelectorAll("h2")].map((h) => h.textContent), ["Protokoll"]);
  assert.doesNotMatch(article.textContent ?? "", /##/);
});

test("an address the page will not follow is shown as its words, not as a link that reloads the page", async () => {
  const view = await document_({
    text: "Se [klicka här](javascript:alert(1)), [kommunen](https://sundsvall.se) och ![en bild](javascript:alert(2)).",
    file: null,
  });
  const article = view.container.querySelector("article")!;
  assert.deepEqual([...article.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["https://sundsvall.se"], "the safe link only; no href=\"\"");
  assert.equal(article.querySelector("img"), null, "no image with an empty source, which asks for the page itself");
  for (const words of ["klicka här", "kommunen", "en bild"]) assert.match(article.textContent ?? "", new RegExp(words), "every word of it is still there");
});

test("a footnote, which the design system's Markdown does not draw, stays as the words it was written as", async () => {
  const view = await document_({ text: "Beslutet togs.[^1]\n\n[^1]: Enligt protokollet.", file: null });
  const article = view.container.querySelector("article")!;
  assert.match(article.textContent ?? "", /Beslutet togs\.\[\^1\]/, "the marker, where it was written");
  assert.match(article.textContent ?? "", /\[\^1\]: Enligt protokollet\./, "and the note it points to, whole");
  assert.equal(article.querySelector("a, section"), null, "no link to nothing, and no section the page does not name");
});

test("a bare address is a link, without the full stop that ends its sentence", async () => {
  const view = await document_({ text: "Se https://sundsvall.se/budget. Skriv till kommun@sundsvall.se.", file: null });
  const article = view.container.querySelector("article")!;
  assert.deepEqual(
    [...article.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent]),
    [["https://sundsvall.se/budget", "https://sundsvall.se/budget"], ["mailto:kommun@sundsvall.se", "kommun@sundsvall.se"]],
  );
});

test("an address on another site opens in a tab of its own, without a handle to the page that holds the work", async () => {
  const view = await document_({ text: "Se [kommunen](https://sundsvall.se).", file: null });
  const link = view.container.querySelector<HTMLAnchorElement>("article a")!;
  assert.equal(link.target, "_blank");
  assert.deepEqual(link.rel.split(" ").sort(), ["noopener", "noreferrer"]);
});

test("the document's one filled action is its file's download; without a file it is copying the text", async () => {
  const withFile = await document_({ text, file: pdf });
  assert.deepEqual(filled(withFile.container), ["Ladda ner PDF, Protokoll kommunstyrelsen 2026-09-24.pdf"]);
  // The file row names the file, and the name opens it; it never offers the same download again. On a phone's width
  // that is a tab of its own, as Öppna PDF above the document.
  const inline = "/api/eneo/flows/flow-1/runs/run-1/artifacts/file-1/content?disposition=inline";
  const name = withFile.container.querySelector<HTMLAnchorElement>(`[data-file-row] a[href="${inline}"]`);
  assert.ok(name, "the file's name is a link to the file");
  assert.equal(name.target, "_blank", "as Öppna PDF: in a new tab");
  assert.equal(nameOf(name), `Öppna ${pdf.name} i en ny flik`);
  assert.equal(name.textContent, pdf.name, "the words it shows are the file's name, in its accessible name");
  const row = name.closest("[data-file-row]")!;
  assert.match(row.textContent ?? "", /PDF, 47,1\u00a0kB/);
  // The dialog's own controls are in the row's markup, closed: what is on the page is the one link.
  const onPage = [...row.querySelectorAll("a, button")].filter((el) => !el.closest("dialog"));
  assert.ok(!onPage.some((el) => el.matches("a[download]")), "no second download in the file row");
  assert.deepEqual(onPage.map(nameOf), [`Öppna ${pdf.name} i en ny flik`], "no second way to open it");
  await withFile.unmount();

  const textOnly = await document_({ text, file: null });
  assert.deepEqual(filled(textOnly.container), ["Kopiera texten"]);
  await textOnly.unmount();
});

test("from a laptop's width the file's name opens the preview instead, and no Öppna beside it does the same again", async (t) => {
  widthOf(t, 1280);
  const view = await document_({ text, file: pdf });
  const row = view.container.querySelector("[data-file-row]")!;
  // The dialog's own controls are in the row's markup, closed: what is on the page is the one trigger.
  const controls = [...row.querySelectorAll("a, button")].filter((el) => !el.closest("dialog"));
  assert.deepEqual(controls.map(nameOf), [`Öppna ${pdf.name}`]);
  assert.equal(controls[0].getAttribute("aria-haspopup"), "dialog");
  assert.ok(!row.querySelector("a[href][target]:not(dialog a)"), "no link to a tab of its own beside it");
  assert.ok(!row.querySelector("a[download]:not(dialog a)"), "no second download in the file row");
  assert.deepEqual(filled(view.container), ["Ladda ner PDF, Protokoll kommunstyrelsen 2026-09-24.pdf"], "one filled action on the document's top edge");
  assert.ok(![...view.container.querySelectorAll("button")].some((b) => b.getAttribute("aria-label") === "Fler alternativ"), "no menu on a wide window");
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
  // Relative to the top heading, not to the number of its hashes: a text that starts at ### is no deeper for it.
  assert.deepEqual(await outline("### Protokoll\n\n#### Beslut\n\nText."), ["H2 Protokoll", "H3 Beslut"]);
  // A code block holds no headings, whatever its fence and whatever it contains.
  assert.deepEqual(
    await outline("## Protokoll\n\n### Beslut\n\n````md\n```\n# inte en rubrik\n```\n````\n\nText."),
    ["H2 Protokoll", "H3 Beslut"],
  );
});

test("an underlined title, which the design system's parser does not read as a heading, stays its words and takes no level from the next one", async () => {
  const view = await document_({ text: "Protokoll\n=========\n\n## Beslut\n\nText.", file: null });
  const article = view.container.querySelector("article")!;
  assert.deepEqual([...article.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => `${h.tagName} ${h.textContent}`), ["H2 Beslut"]);
  assert.match(article.textContent ?? "", /Protokoll/, "the title is still there");
});

test("on a narrower screen the one more action beside the download is a button, not a menu of one", async () => {
  const view = await document_({ text, file: pdf });
  const buttons = [...view.container.querySelectorAll("button")].map(nameOf);
  assert.ok(buttons.includes("Kopiera texten"), "Kopiera texten, where it can be seen");
  assert.ok(!buttons.includes("Fler alternativ"), "no menu for a single action");
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
    // Dela alone: a button of its own, not a menu of one.
    const alone = await document_({ text: null, file: pdf });
    await alone.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const names = [...alone.container.querySelectorAll("button")].map(nameOf);
    assert.ok(names.includes("Dela") && !names.includes("Fler alternativ"), `Dela is a button and no menu holds it (${names})`);
    await alone.unmount();

    // Beside Kopiera texten there are two: a menu.
    const view = await document_({ text, file: pdf });
    await view.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const more = [...view.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Fler alternativ")!;
    await view.act(async () => more.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    assert.deepEqual(items.map((item) => item.textContent?.trim()), ["Kopiera texten", "Dela"]);
    await view.act(async () => items[1].click());
    assert.equal(shared.length, 1);
    assert.equal(shared[0].files?.[0].name, "Protokoll kommunstyrelsen 2026-09-24.pdf");
    assert.equal(shared[0].title, "Nämndmöte till rapport");
  } finally {
    Reflect.deleteProperty(navigator, "share");
    Reflect.deleteProperty(navigator, "canShare");
    globalThis.fetch = realFetch;
  }
});

test("the PDF opens on its title, with its actions and Stäng before the viewer, and is fetched only then", async (t) => {
  widthOf(t, 1280);
  filesAnswer(t, present);
  const { createElement } = await import("react");
  const { ResultFiles } = await import("../components/flow/ResultFiles");
  const view = await inProviders(createElement(ResultFiles, { flowId: "flow-1", runId: "run-1", files: [pdf] }));
  const open = [...view.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-haspopup") === "dialog")!;
  assert.equal(document.querySelector("iframe"), null, "closed: no PDF is fetched");
  await view.act(async () => open.click());
  const dialog = document.querySelector<HTMLElement>("dialog[open]")!;
  assert.ok(dialog, "an open dialog");
  assert.equal(dialog.getAttribute("aria-labelledby") && document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent, pdf.name, "named by its title");
  assert.equal(document.activeElement?.textContent, pdf.name, "focus on the title, not in the viewer");
  const order = [...dialog.querySelectorAll("button, a, iframe")].map((el) => (el.tagName === "IFRAME" ? "viewer" : nameOf(el)));
  assert.deepEqual(order, ["Öppna i ny flik", "Ladda ner", "Stäng", "viewer"]);
  // Tab never enters the browser's PDF frame, which keeps Escape and shows no focus; "Öppna i ny flik" reads it.
  assert.equal(dialog.querySelector("iframe")!.tabIndex, -1, "the viewer is not a Tab stop");

  // Stäng closes it, the viewer goes with it, and focus is back on what opened it.
  await view.act(async () => button(dialog, "Stäng")!.click());
  assert.equal(document.querySelector("dialog[open]"), null);
  assert.equal(document.querySelector("iframe"), null, "closed again: nothing fetched");
  assert.equal(document.activeElement, open, "focus is back on the trigger");
});

test("the PDF preview is closed while the login has ended, and is back with its viewer when it is", async (t) => {
  widthOf(t, 1280);
  filesAnswer(t, present);
  const { createElement } = await import("react");
  const { ResultFiles } = await import("../components/flow/ResultFiles");
  const { loginState } = await import("./login-state");
  const anna = { id: "user-1", email: "anna@example.se", username: "Anna" };
  const status = (authenticated: boolean) => ({ authenticated, user: authenticated ? anna : null });
  const end = loginState.begin(anna);
  t.after(end);
  const view = await inProviders(createElement(ResultFiles, { flowId: "flow-1", runId: "run-1", files: [pdf] }));
  const open = [...view.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-haspopup") === "dialog")!;
  await view.act(async () => open.click());
  assert.ok(document.querySelector("dialog[open]"));
  const viewer = document.querySelector("iframe");

  // A native dialog is no part of what the cover makes inert: the page closes it, and keeps its viewer to come back to.
  await view.act(async () => loginState.observe(status(false)));
  assert.equal(document.querySelector("dialog[open]"), null, "nothing of it shown while signed out");
  assert.equal(document.querySelector("iframe"), viewer, "the viewer is kept, not fetched again");
  await view.act(async () => loginState.observe(status(true)));
  assert.ok(document.querySelector("dialog[open]"), "back after the new login");
  assert.equal(document.querySelector("iframe"), viewer);
});

test("the PDF preview stays open, with its viewer, when the window crosses the breakpoint, and focus stays in it", async (t) => {
  const resize = widthOf(t, 1280);
  filesAnswer(t, present);
  const { createElement } = await import("react");
  const { ResultFiles } = await import("../components/flow/ResultFiles");
  const view = await inProviders(createElement(ResultFiles, { flowId: "flow-1", runId: "run-1", files: [pdf] }));
  const open = [...view.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-haspopup") === "dialog")!;
  await view.act(async () => open.click());
  const dialog = document.querySelector<HTMLElement>("dialog[open]")!;
  const viewer = dialog.querySelector("iframe")!;
  assert.ok(dialog.contains(document.activeElement), "focus starts in the dialog");

  // The page is made narrow while the dialog is open: it is the same dialog and the same viewer, not a reload.
  await view.act(async () => resize(390));
  assert.equal(document.querySelector("dialog[open]"), dialog, "still open, the same element");
  assert.equal(dialog.querySelector("iframe"), viewer, "the viewer is not fetched again");
  assert.ok(dialog.contains(document.activeElement), "focus has not dropped to the page");
  await view.act(async () => resize(1280));
  assert.equal(document.querySelector("dialog[open]"), dialog);
  assert.equal(dialog.querySelector("iframe"), viewer);

  // Closed on the narrow page, focus is given to what opens the preview there.
  await view.act(async () => resize(390));
  await view.act(async () => button(dialog, "Stäng")!.click());
  assert.equal(document.querySelector("dialog[open]"), null);
  assert.equal(document.activeElement, view.container.querySelector('a[target="_blank"]'), "the link that opens it in a tab has focus");
});

test("narrower than a laptop a PDF opens in a tab of its own, and says so", async (t) => {
  widthOf(t, 390);
  const { createElement } = await import("react");
  const { ResultFiles } = await import("../components/flow/ResultFiles");
  const view = await inProviders(createElement(ResultFiles, { flowId: "flow-1", runId: "run-1", files: [pdf] }));
  assert.ok(!document.querySelector("dialog[open]") && !document.querySelector("iframe"), "a closed dialog, so nothing is fetched ahead");
  const open = view.container.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
  assert.equal(nameOf(open), `Öppna ${pdf.name} i en ny flik`);
  assert.equal(open.rel, "noopener noreferrer");
  assert.equal(open.textContent, "Öppna");
});

test("a file that cannot be fetched shows its name and size and nothing to press", async () => {
  const { createElement } = await import("react");
  const { ResultFiles } = await import("../components/flow/ResultFiles");
  const view = await inProviders(createElement(ResultFiles, { flowId: "flow-1", runId: "run-1", files: [{ ...pdf, available: false }] }));
  const row = view.container.querySelector("li")!;
  assert.match(row.textContent ?? "", /Protokoll kommunstyrelsen 2026-09-24\.pdf/);
  assert.match(row.textContent ?? "", /PDF, 47,1\u00a0kB/);
  assert.equal(row.querySelectorAll("a, button").length, 0);
});

test("narrower than a laptop, Dokument and Transkribering are tabs that keep each other's state", async (t) => {
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
    await asPerson(createElement(RunResult, {
      flowId: "flow-1",
      flowName: "Nämndmöte till rapport",
      run: { id: "run-1", flow_id: "flow-1", status: "completed", revision: 1, finished_at: "2026-09-24T09:02:00Z", result: { kind: "artifact", files: [{ file_id: "file-1" }] } } as never,
      steps: [],
      stepResults: [transcribe] as never,
      files: [pdf],
      onNewRecording: () => undefined,
      onRegenerated: () => undefined,
    })),
  );
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const tab = (name: string) => tabsIn(view.container).find((b) => tabLabel(b) === name)!;
  assert.equal(tab("Dokument").getAttribute("aria-selected"), "true", "the document first");
  const panels = [...view.container.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
  assert.equal(panels.length, 2, "both views stay mounted");
  // A panel taller than the screen cannot show its focus; each starts with its own controls, so Tab goes there.
  assert.deepEqual(panels.map((p) => p.getAttribute("tabindex")), [null, null], "the panels are not tab stops");
  // Each panel is named by its tab and its tab points at it; only the chosen one is shown.
  assert.deepEqual(panels.map((p) => tabLabel(document.getElementById(p.getAttribute("aria-labelledby")!)!)), ["Dokument", "Transkribering"]);
  assert.deepEqual(tabsIn(view.container).map((t) => t.getAttribute("aria-controls")), panels.map((p) => p.id));
  assert.deepEqual(panels.map((p) => p.hidden), [false, true]);

  const { computeAccessibleName } = await import("dom-accessibility-api");
  // The search is found by the name a screen reader gives it: the design system's input is named by its label.
  const searchBox = () => [...view.container.querySelectorAll<HTMLInputElement>("input")].find((input) => computeAccessibleName(input) === "Sök i transkriberingen")!;
  const search = searchBox();
  await view.act(async () => tab("Transkribering").click());
  const { type } = await import("./test-dom");
  await view.act(async () => type(search, "punkten"));
  await view.act(async () => tab("Dokument").click());
  assert.deepEqual([...view.container.querySelectorAll<HTMLElement>('[role="tabpanel"]')].map((p) => p.hidden), [false, true], "the document is back");
  await view.act(async () => tab("Transkribering").click());
  assert.equal(searchBox().value, "punkten", "the search is kept");
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
    await asPerson(createElement(RunResult, {
      flowId: "flow-1",
      flowName: "Nämndmöte till rapport",
      run: { id: "run-1", flow_id: "flow-1", status: "completed", revision: 1, finished_at: "2026-09-24T09:02:00Z", result: { kind: "artifact", files: [{ file_id: "file-1" }] } } as never,
      steps: [],
      stepResults: [transcribe] as never,
      files: [pdf],
      onNewRecording: () => undefined,
      onRegenerated: () => undefined,
    })),
  );
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const note = () => view.container.querySelector('[role="note"]');
  assert.ok(note(), "saved corrections are newer than the document");
  assert.equal(button(note()!, "Skapa dokumentet igen med rättningarna")!.disabled, false);

  // A later correction fails to save.
  await view.act(async () => button(view.container, "Talare 1, ändra talare")!.click());
  await view.act(async () => document.querySelector<HTMLInputElement>('[data-popover-open] input[type="radio"][value="SPEAKER_01"]')!.click());
  await view.act(async () => button(document.body, "Spara")!.click());
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.ok(note(), "still said: the document is older than the saved corrections");
  const make = [...note()!.querySelectorAll("button")].find((b) => b.textContent?.includes("Skapa dokumentet igen"))!;
  assert.equal(make.disabled, true, "a new document waits for the failed save");
  assert.match(note()!.textContent ?? "", /inte sparad/);
});

test("a save refused as stale reads the saved corrections again, says so, and offers no retry of what could not be saved", async (t) => {
  const { createElement } = await import("react");
  const { RunResult } = await import("../components/flow/RunResult");
  const original = globalThis.fetch;
  t.after(() => void (globalThis.fetch = original));
  const hash = "a".repeat(64);
  let reads = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.includes("transcript-words")) return Response.json({ code: "not_found" }, { status: 404 });
    if (path.includes("transcript-corrections") && init?.method === "PATCH") {
      return Response.json({ code: "flow_transcript_corrections_stale_revision" }, { status: 409 });
    }
    if (path.includes("transcript-corrections")) {
      reads += 1;
      return Response.json([{ flow_run_id: "run-1", step_id: "step-1", schema_version: 3, segments_hash: hash, occurrences: [], speaker_edits: [], revision: reads, stale: false, updated_at: "2026-09-24T10:00:00Z" }]);
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
    await asPerson(createElement(RunResult, {
      flowId: "flow-1",
      flowName: "Nämndmöte till rapport",
      run: { id: "run-1", flow_id: "flow-1", status: "completed", revision: 1, finished_at: "2026-09-24T09:02:00Z", result: { kind: "artifact", files: [{ file_id: "file-1" }] } } as never,
      steps: [],
      stepResults: [transcribe] as never,
      files: [pdf],
      onNewRecording: () => undefined,
      onRegenerated: () => undefined,
    })),
  );
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(reads, 1);
  await view.act(async () => button(view.container, "Talare 1, ändra talare")!.click());
  await view.act(async () => document.querySelector<HTMLInputElement>('[data-popover-open] input[type="radio"][value="SPEAKER_01"]')!.click());
  await view.act(async () => button(document.body, "Spara")!.click());
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(reads, 2, "the saved corrections are read again");
  assert.match(view.container.textContent ?? "", /har laddats om/);
  assert.ok(!button(view.container, "Försök spara igen"), "nothing is left to retry: the correction is to be made again");
  assert.ok(!(view.container.textContent ?? "").includes("osparade rättningar finns kvar"));
});

/** The result page with a transcript to correct, whose saves are answered by `onSave`; the person picks Talare 2 for the first passage. */
async function correcting(t: TestContext, onSave: () => Promise<Response>) {
  const { createElement } = await import("react");
  const { RunResult } = await import("../components/flow/RunResult");
  const original = globalThis.fetch;
  t.after(() => void (globalThis.fetch = original));
  const hash = "a".repeat(64);
  let reads = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.includes("transcript-words")) return Response.json({ code: "not_found" }, { status: 404 });
    if (path.includes("transcript-corrections") && init?.method === "PATCH") return onSave();
    if (path.includes("transcript-corrections")) {
      reads += 1;
      return Response.json([{ flow_run_id: "run-1", step_id: "step-1", schema_version: 3, segments_hash: hash, occurrences: [], speaker_edits: [], revision: reads, stale: false, updated_at: "2026-09-24T10:00:00Z" }]);
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
    await asPerson(createElement(RunResult, {
      flowId: "flow-1",
      flowName: "Nämndmöte till rapport",
      run: { id: "run-1", flow_id: "flow-1", status: "completed", revision: 1, finished_at: "2026-09-24T09:02:00Z", result: { kind: "artifact", files: [{ file_id: "file-1" }] } } as never,
      steps: [],
      stepResults: [transcribe] as never,
      files: [pdf],
      onNewRecording: () => undefined,
      onRegenerated: () => undefined,
    })),
  );
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const correct = async () => {
    await view.act(async () => button(view.container, "Talare 1, ändra talare")!.click());
    await view.act(async () => document.querySelector<HTMLInputElement>('[data-popover-open] input[type="radio"][value="SPEAKER_01"]')!.click());
    await view.act(async () => button(document.body, "Spara")!.click());
  };
  return { view, correct };
}

/** Whether leaving now would ask the browser's own question. */
const asksBeforeLeaving = () => {
  const event = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

test("while a correction is being saved, or could not be, closing the page asks first; once it is saved it does not", async (t) => {
  let answer: (response: Response) => void = () => {};
  const { view, correct } = await correcting(t, () => new Promise<Response>((resolve) => void (answer = resolve)));
  assert.equal(asksBeforeLeaving(), false, "nothing to lose yet");
  await correct();
  assert.equal(asksBeforeLeaving(), true, "the save has not been answered");
  await view.act(async () => answer(Response.json({ flow_run_id: "run-1", step_id: "step-1", schema_version: 3, segments_hash: "a".repeat(64), occurrences: [], speaker_edits: [{ segment_index: 0, char_start: null, char_end: null, original: null, original_speaker: "SPEAKER_00", speaker: "SPEAKER_01", decision: "confirmed" }], revision: 2, stale: false, updated_at: "2026-09-24T10:01:00Z" })));
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(asksBeforeLeaving(), false, "saved");
});

test("a correction that could not be saved keeps the page asking before it is closed", async (t) => {
  const { view, correct } = await correcting(t, async () => Response.json({ code: "service_unavailable" }, { status: 503 }));
  await correct();
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.ok(button(view.container, "Försök spara igen"), "the save failed");
  assert.equal(asksBeforeLeaving(), true);
});

test("a save refused as stale keeps what the person corrected, to take with them, after the others' corrections are read", async (t) => {
  const download = await import("./download");
  const kept: Blob[] = [];
  t.mock.method(download, "downloadBlob", (blob: Blob) => void kept.push(blob));
  const { view, correct } = await correcting(t, async () => Response.json({ code: "flow_transcript_corrections_stale_revision" }, { status: 409 }));
  await correct();
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.match(view.container.textContent ?? "", /har laddats om/);
  assert.equal(asksBeforeLeaving(), true, "what the person typed is not kept anywhere else");
  await view.act(async () => button(view.container, "Hämta dina rättningar")!.click());
  const saved = JSON.parse(await kept[0].text());
  assert.deepEqual(saved.speaker_edits.map((edit: { speaker: string }) => edit.speaker), ["SPEAKER_01"], "their change, not the reloaded set");
});

test("Dela's read ahead does not start over when the page draws again with the same file", async (t) => {
  const { createElement } = await import("react");
  const { ModuleProviders } = await import("@/kit/ModuleProviders");
  const { ResultDocument } = await import("../components/flow/ResultDocument");
  const realFetch = globalThis.fetch;
  const fetched: AbortSignal[] = [];
  Object.defineProperty(navigator, "share", { value: async () => undefined, configurable: true });
  Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    fetched.push(init!.signal!);
    return new Promise<Response>(() => undefined);
  }) as typeof fetch;
  t.after(() => {
    Reflect.deleteProperty(navigator, "share");
    Reflect.deleteProperty(navigator, "canShare");
    globalThis.fetch = realFetch;
  });
  const draw = (file: ResultFileView) =>
    createElement(ModuleProviders, null, createElement(ResultDocument, { flowId: "flow-1", runId: "run-1", title: "Nämndmöte till rapport", text, file }));
  const view = await mount(draw(pdf));
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(fetched.length, 1);
  // The run's page builds its file views anew at every draw: the same file, another object.
  await view.act(async () => view.rerender(draw({ ...pdf })));
  assert.equal(fetched.length, 1, "no second read of the same file");
  assert.equal(fetched[0].aborted, false, "and the first is not cut off");
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
    withRouter(
      await asPerson(createElement(RunResult, {
        flowId: "flow-1", flowName: "Nämndmöte till rapport",
        run: { id: "run-1", flow_id: "flow-1", status: "completed", revision: 1, finished_at: "2026-09-24T09:02:00Z", result: { kind: "inline_text", text } } as never,
        steps: [], stepResults: [transcribe] as never, files: [pdf],
        onNewRecording: () => undefined, onRegenerated: () => undefined,
      })),
    ).tree,
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
    await asPerson(createElement(RunResult, {
      flowId: "flow-1",
      flowName: "Nämndmöte till rapport",
      run: { id: "run-1", flow_id: "flow-1", status: "completed", revision: 1, finished_at: "2026-09-24T09:02:00Z", result: { kind: "artifact", files: [{ file_id: "file-1" }] } } as never,
      steps: [],
      stepResults: [
        { id: "result-1", step_id: "step-1", status: "completed", output_payload_json: { text: "Välkomna till mötet." } },
        { id: "result-2", step_id: "step-2", status: "completed", model_parameters_json: { model_id: "model-1" }, output_payload_json: { text } },
      ] as never,
      files: [pdf],
      showTranscript: false,
      onNewRecording: () => undefined,
      onRegenerated: () => undefined,
    })),
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
    await asPerson(createElement(RunResult, {
      flowId: "flow-1",
      flowName: "Intervju till sammanfattning",
      run: { id: "run-1", flow_id: "flow-1", flow_version: 7, status: "completed", revision: 1, finished_at: "2026-09-24T09:02:00Z", result: { kind: "inline_text", text } } as never,
      contract: { flow_id: "flow-1", published_flow_version: 7, final_output: { output_type: "text", delivery: "payload" } },
      steps: [],
      stepResults: [transcribe] as never,
      files: [],
      onNewRecording: () => undefined,
      onRegenerated: () => undefined,
    })),
  );
  await view.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(view.container.querySelector("h1")?.textContent, "Texten är klar");
  const note = view.container.querySelector('[role="note"]')!;
  assert.match(note.textContent ?? "", /^Texten skapades före dina rättningar/);
  assert.ok(button(note, "Skapa texten igen med rättningarna"), "Skapa texten igen");
  assert.deepEqual(tabsIn(view.container).map(tabLabel), ["Text", "Transkribering"]);
  assert.ok(view.container.querySelector('[role="region"][aria-label="Texten"]'), "the text, named as such");
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
  // A flow that sends its JSON on makes neither: the words stay neutral.
  assert.equal(await heading("json", "outbound_http"), "Resultatet kunde inte skapas");
});

test("a long text in one paragraph shows its first part too, cut between two words", async () => {
  const paragraph = "Nämnden diskuterade ärendet och beslutade enligt förslaget. ".repeat(125).trim();
  const view = await document_({ text: null, file: pdf, preview: paragraph });
  const preview = previewOf(view.container)!;
  const more = button(preview, "Visa hela texten");
  assert.ok(more, "Visa hela texten");
  const article = document.getElementById(more.getAttribute("aria-controls")!)!;
  const shown = article.textContent ?? "";
  assert.ok(shown.length < paragraph.length / 3, `only the first part: ${shown.length} of ${paragraph.length}`);
  assert.ok(shown.endsWith(" …"), "says the text goes on");
  const start = shown.slice(0, -2);
  assert.ok(paragraph.startsWith(start) && paragraph[start.length] === " ", "cut between two words");
  await view.act(async () => more.click());
  assert.equal(article.textContent, paragraph);
});

test("the document is the file Eneo names as the run's result, not the first file any step made", async (t) => {
  const { createElement } = await import("react");
  const { RunResult } = await import("../components/flow/RunResult");
  const original = globalThis.fetch;
  t.after(() => void (globalThis.fetch = original));
  globalThis.fetch = (async () => Response.json([])) as typeof fetch;
  const earlier: ResultFileView = { ...pdf, fileId: "file-0", name: "Underlag.pdf", stepId: "step-1" };
  const view = await mount(
    await asPerson(createElement(RunResult, {
      flowId: "flow-1",
      flowName: "Nämndmöte till rapport",
      run: {
        id: "run-1", flow_id: "flow-1", status: "completed", revision: 1, finished_at: "2026-09-24T09:02:00Z",
        result: { kind: "artifact", files: [{ file_id: "file-1", name: pdf.name, mimetype: "application/pdf" }] },
      } as never,
      steps: [],
      stepResults: [],
      files: [earlier, pdf],
      showTranscript: false,
      onNewRecording: () => undefined,
      onRegenerated: () => undefined,
    })),
  );
  assert.match(view.container.querySelector("[data-file-row]")?.textContent ?? "", /Protokoll kommunstyrelsen/, "the final step's file");
  const more = view.container.querySelector('section[aria-labelledby="result-files"]');
  assert.match(more?.textContent ?? "", /Fler filerUnderlag\.pdf/, "the earlier step's file listed under it");
});


test("a run's file is checked without Range and its body is cancelled before it is read", async () => {
  const { checkRunArtifact } = await import("./api");
  const { ApiError } = await import("./api");
  const seen: { url: string; range: string | null }[] = [];
  const real = globalThis.fetch;
  let reads = 0;
  let cancelled = 0;
  let answer: () => Response = () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      controller.enqueue(new Uint8Array(1024));
      if (reads > 1) controller.close();
    },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 }), { headers: { "Content-Type": "application/pdf" } });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), range: new Headers(init?.headers).get("Range") });
    return answer();
  }) as typeof fetch;
  try {
    await checkRunArtifact("flow-1", "run-1", "file-1");
    assert.deepEqual(seen, [{ url: ATTACHMENT, range: null }], "older Eneo versions reject Range for a PDF");
    assert.equal(reads, 0, "no file body is read into memory");
    assert.equal(cancelled, 1, "the upstream stream is released");
    answer = missing;
    await assert.rejects(checkRunArtifact("flow-1", "run-1", "file-1"), (error: unknown) => error instanceof ApiError && error.status === 404);
  } finally {
    globalThis.fetch = real;
  }
});

test("a PDF that Eneo no longer has is not opened: no raw answer in the viewer, the row says so, and Försök igen asks again", async (t) => {
  widthOf(t, 1280);
  let gone = true;
  const asked = filesAnswer(t, () => (gone ? missing() : present()));
  const { createElement } = await import("react");
  const { ResultFiles } = await import("../components/flow/ResultFiles");
  const view = await inProviders(createElement(ResultFiles, { flowId: "flow-1", runId: "run-1", files: [pdf] }));
  const open = [...view.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-haspopup") === "dialog")!;

  await view.act(async () => open.click());
  assert.equal(asked.length, 1);
  assert.equal(asked[0].range, null, "the availability check also supports older Eneo document routes");
  assert.equal(document.querySelector("dialog[open]"), null, "no dialog");
  assert.equal(document.querySelector("iframe"), null, "no viewer to show the module's answer in");
  assert.deepEqual(alertsOf(view.container), ["Filen finns inte kvar hos Eneo.Försök igen"]);
  assert.doesNotMatch(document.body.textContent ?? "", /File not found/, "Eneo's words are not shown");

  gone = false;
  await view.act(async () => button(view.container, "Försök igen")!.click());
  assert.equal(asked.length, 2);
  assert.ok(document.querySelector("dialog[open] iframe"), "opened now");
  assert.equal(document.querySelector("iframe")!.getAttribute("src"), INLINE);
  assert.deepEqual(alertsOf(view.container), [], "the notice is gone");
});

test("a download starts only once the file is known to be there; if it is not, the row says why and Försök igen tries again", async (t) => {
  widthOf(t, 1280);
  let answer: () => Response = missing;
  const asked = filesAnswer(t, () => answer());
  const started = downloads(t);
  const { createElement } = await import("react");
  const { ResultFiles } = await import("../components/flow/ResultFiles");
  const view = await inProviders(createElement(ResultFiles, { flowId: "flow-1", runId: "run-1", files: [pdf] }));
  // The closed preview dialog holds a download link of its own; this is the row's.
  const link = () => [...view.container.querySelectorAll<HTMLAnchorElement>(`a[href="${ATTACHMENT}"]`)].find((a) => !a.closest("dialog"))!;

  await view.act(async () => void press(link()));
  assert.equal(asked.length, 1);
  assert.deepEqual(started, [], "nothing is saved: it would be the module's answer under the file's name");
  assert.deepEqual(alertsOf(view.container), ["Filen finns inte kvar hos Eneo.Försök igen"]);

  answer = () => new Response("Service Unavailable", { status: 503 });
  await view.act(async () => button(view.container, "Försök igen")!.click());
  assert.deepEqual(alertsOf(view.container), ["Servern kunde inte nås just nu. Försök igen om en stund.Försök igen"], "another failure, in its own words");

  answer = present;
  await view.act(async () => button(view.container, "Försök igen")!.click());
  assert.deepEqual(started, [`${ATTACHMENT} (download)`], "saved once, by the link the page makes");
  assert.deepEqual(alertsOf(view.container), []);
});

test("narrower than a laptop the tab opens at the press and goes to the file once it is there; a file that is not closes it again", async (t) => {
  widthOf(t, 390);
  let answer: () => Response = missing;
  filesAnswer(t, () => answer());
  const opened = tabs(t);
  const { createElement } = await import("react");
  const { ResultFiles } = await import("../components/flow/ResultFiles");
  const view = await inProviders(createElement(ResultFiles, { flowId: "flow-1", runId: "run-1", files: [pdf] }));
  const link = () => view.container.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;

  await view.act(async () => void press(link()));
  assert.equal(opened.length, 1, "opened by the press itself, which no pop-up blocker stops");
  assert.equal(opened[0].closed, true, "closed again: there is no file to show in it");
  assert.deepEqual(alertsOf(view.container), ["Filen finns inte kvar hos Eneo.Försök igen"]);

  answer = present;
  await view.act(async () => button(view.container, "Försök igen")!.click());
  assert.equal(opened.length, 2);
  assert.equal(opened[1].closed, false);
  assert.equal(opened[1].url, INLINE, "sent to the file");
  assert.equal(opened[1].opener, null, "which cannot reach back to this page");
  assert.deepEqual(alertsOf(view.container), []);
});

test("the document's own download is checked the same way", async (t) => {
  widthOf(t, 390);
  filesAnswer(t, missing);
  const started = downloads(t);
  const view = await document_({ text, file: pdf });
  const link = view.container.querySelector<HTMLAnchorElement>(`a[href="${ATTACHMENT}"]`)!;
  await view.act(async () => void press(link));
  assert.deepEqual(started, []);
  assert.deepEqual(alertsOf(view.container), ["Filen finns inte kvar hos Eneo.Försök igen"]);
});
