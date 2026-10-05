import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AuthenticatedUserContext } from "../components/AuthGate";
import { EarlierRuns } from "../components/flow/EarlierRuns";
import type { EarlierRunsSnapshot } from "./earlier-runs";

/** The signed-in person a page behind AuthGate has. */
const person = { id: "user-1", email: "anna@example.se", username: "Anna Berg" };

const listed = (runs: EarlierRunsSnapshot["runs"]): EarlierRunsSnapshot => ({ runs, hasMore: false, loading: false, failed: null });
import { ResultFiles } from "../components/flow/ResultFiles";
import { RunFailure } from "../components/flow/RunFailure";
import { RunOpening, RunProgress, RunUnread } from "../components/flow/RunProgress";
import { SubmittingView, type SubmissionState } from "../components/flow/SubmittingView";
import { RunResult } from "../components/flow/RunResult";
import { StepDetails } from "../components/flow/StepDetails";
import { RunTranscriptView } from "../components/flow/RunTranscript";
import type { TranscriptContext } from "./transcript-context";
import { EMPTY_CORRECTIONS } from "./transcript-corrections";
import { listOwnRuns } from "./api";
import { inStaticRouter } from "./test-router";
import type { ResultFileView } from "./run-files";
import type { StepView } from "./run-progress";

/** Markup as the page renders it once, inside the router that its way-back link needs. */
const markup = (element: import("react").ReactElement) => renderToStaticMarkup(inStaticRouter(element));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
// The words of every status region (a paragraph) in the markup, in order: what a screen reader is told when they change.
const statuses = (html: string) => [...html.matchAll(/<p[^>]*role="status"[^>]*>(.*?)<\/p>/g)].map(([, inner]) => text(inner));

const running: StepView[] = [
  { order: 1, label: "Transkribera mötet", state: "done", transcribes: true, note: null },
  { order: 2, label: "Analysera mötesinnehållet", state: "running", transcribes: false, note: null },
  { order: 3, label: "Skapa rapport", state: "waiting", transcribes: false, note: "Här granskar du resultatet." },
];

test("the running view names the stage once in a status region and says each step's state in words", () => {
  const html = markup(
    createElement(RunProgress, { flowName: "Nämndmöte", steps: running, stage: "Analysera mötesinnehållet", onCancel: async () => undefined }),
  );

  assert.match(html, /<h1[^>]*tabindex="-1"[^>]*>Dokumentet skapas<\/h1>/);
  assert.deepEqual(statuses(html), ["Analysera mötesinnehållet"], "the stage, once, in the only status region");
  const words = text(html);
  assert.match(words, /Transkribera mötet Klar/);
  assert.match(words, /Analysera mötesinnehållet Pågår/);
  assert.match(words, /Skapa rapport Väntar Här granskar du resultatet\./, "a step that will stop for the person says so");
  assert.doesNotMatch(words, /I kö/);
  assert.match(words, /Dokumentet blir klart även om du stänger sidan\. Du hittar det här sedan\./);
  assert.doesNotMatch(words, /Du kan stänga sidan/, "reassurance, not an instruction to close");
  assert.match(words, /Avbryt körningen/);
  // The step list is an ordered list, so a screen reader hears position and state.
  assert.match(html, /<ol[^>]*>(\s*<li)/);
});

test("a flow that makes text says the text will be ready, as its action says Skapa text", () => {
  const words = text(
    markup(
      createElement(RunProgress, { flowName: "Intervju", steps: running, stage: "Analysera mötesinnehållet", makesText: true, onCancel: async () => undefined }),
    ),
  );
  assert.match(words, /Texten blir klar även om du stänger sidan\. Du hittar den här sedan\./);
  assert.doesNotMatch(words, /Dokumentet blir klart/);
  assert.match(words, /^Texten skapas /, "the heading");
  assert.doesNotMatch(words, /[Dd]okument/);
  const sending = markup(
    createElement(SubmittingView, { submission: { kind: "starting", wait: null }, onCancelSubmission: () => undefined, makesText: true }),
  );
  assert.match(sending, /<h1[^>]*>Texten skapas<\/h1>/, "the same heading while it is sent, so nothing changes when the run starts");
});

test("a long wait says how long the run has gone on and that it can take minutes, outside the stage's status region", () => {
  const view = (startedAt?: string) =>
    markup(
      createElement(RunProgress, { flowName: "Nämndmöte", steps: running, stage: "Tar fram texten", startedAt, onCancel: async () => undefined }),
    );
  const html = view(new Date(Date.now() - 12 * 60_000 - 5_000).toISOString());
  assert.match(text(html), /Tar fram texten Har pågått i 12 min\. Det kan ta några minuter\./);
  // The minutes count on without being read out on every change.
  assert.ok(statuses(html).every((status) => !/Har pågått/.test(status)), "the elapsed time is in no status region");
  assert.match(text(view(undefined)), /Tar fram texten Det kan ta några minuter\./, "before the start is known");
});

test("a run with no steps shown yet has no step region, and one that could not be stopped says so once, as an alert", () => {
  const view = (extra: Record<string, unknown>) =>
    markup(createElement(RunProgress, { flowName: "Nämndmöte", steps: [], stage: "Startar körningen", onCancel: async () => undefined, ...extra }));
  assert.doesNotMatch(view({}), /Flödets steg/);
  assert.doesNotMatch(view({}), /role="alert"/);
  const failed = view({ error: "Körningen kunde inte avbrytas just nu." });
  assert.equal(failed.match(/role="alert"/g)?.length, 1, "one alert");
  assert.match(failed, /role="alert"(?:(?!<button).)*Körningen kunde inte avbrytas just nu\./, "the sentence is in the alert");
});

test("opening an earlier run is a busy placeholder that says so once and has no heading to move to", () => {
  const html = markup(createElement(RunOpening));
  assert.match(html, /aria-busy="true"/);
  assert.deepEqual(statuses(html), ["Hämtar körningen…"]);
  assert.doesNotMatch(html, /<h[1-6]/);
});

const uploading = (extra: Partial<Extract<SubmissionState, { kind: "uploading" }>> = {}) =>
  markup(
    createElement(SubmittingView, {
      submission: { kind: "uploading", filename: "möte.wav", loaded: 512, total: 2048, percent: 25, wait: null, ...extra },
      onCancelSubmission: () => undefined,
    }),
  );

test("an upload names its bar, shows the bytes and the percent, and keeps Avbryt beside the file name", () => {
  const html = uploading({ percent: 33 });
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="33"|aria-valuenow="33"[^>]*role="progressbar"/);
  const words = text(html);
  assert.match(words, /möte\.wav Avbryt/);
  assert.match(words, /512 B av 2 kB 33%/);
  assert.deepEqual(statuses(html).slice(0, 1), ["Laddar upp filen"], "the stage once, first");
});

test("an upload of unknown size moves without a value and says Pågår, never a made-up percent", () => {
  const html = uploading({ percent: null, total: null, loaded: 4096 });
  assert.match(html, /role="progressbar"/);
  assert.doesNotMatch(html, /aria-valuenow/);
  const words = text(html);
  assert.match(words, /Pågår/);
  assert.doesNotMatch(words, / av |%/);
});

test("a percent outside 0 to 100 is held to it, in the bar and in the words beside it", () => {
  for (const [percent, shown] of [[140, 100], [-5, 0]] as const) {
    const html = uploading({ percent });
    assert.match(html, new RegExp(`aria-valuenow="${shown}"`), `${percent} on the bar`);
    assert.match(text(html), new RegExp(`${shown}%`), `${percent} in words`);
  }
});

test("every quarter of an upload is said once, and the counting percent never is", () => {
  const said = (percent: number | null) => statuses(uploading({ percent }))[1];
  assert.equal(said(null), "");
  assert.equal(said(24), "", "before the first quarter");
  assert.equal(said(25), "25 % uppladdat.");
  assert.equal(said(74), "50 % uppladdat.");
  assert.equal(said(99), "75 % uppladdat.");
  assert.equal(said(100), "100 % uppladdat.");
  assert.ok(statuses(uploading({ percent: 33 })).every((status) => !/33/.test(status)));
});

test("before the file moves there is no bar and no Avbryt; while the run starts a wait shows, still no Avbryt", () => {
  const send = (submission: SubmissionState) =>
    markup(createElement(SubmittingView, { submission, onCancelSubmission: () => undefined }));
  const idle = send({ kind: "idle" });
  assert.deepEqual(statuses(idle), ["Skickar"]);
  assert.doesNotMatch(idle, /progressbar|Avbryt/);
  const waiting = send({ kind: "starting", wait: { retryAt: Date.now() + 5_000, retryNow: () => undefined } });
  assert.equal(statuses(waiting)[0], "Startar flödet");
  assert.match(text(waiting), /Försöker igen om \d+ s\./);
  assert.doesNotMatch(waiting, /progressbar|Avbryt/);
});

const created = new Date(2026, 8, 23, 16, 2).toISOString();
const steps: StepView[] = [
  { order: 1, label: "Transkribera mötet", state: "done", transcribes: true, note: null },
  { order: 2, label: "Analysera mötesinnehållet", state: "failed", transcribes: false, note: null },
  { order: 3, label: "Skriv sammanfattning", state: "not_run", transcribes: false, note: null },
  { order: 4, label: "Skapa rapport", state: "not_run", transcribes: false, note: null },
];
const report: ResultFileView = {
  fileId: "file-1",
  name: "Nämndmöte till rapport 2026-09-23.pdf",
  kind: "pdf",
  typeLabel: "PDF",
  mimeType: "application/pdf",
  sizeBytes: 13_619,
  meta: "PDF, 13,3\u00a0kB",
  available: true,
  previewable: true,
  stepId: null,
};

/** The attributes of every tag with this name in some markup, as the browser would read them. */
const tagsOf = (html: string, tag: string) =>
  [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "g"))].map(([, attrs]) =>
    Object.fromEntries([...attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, value ?? ""])),
  );

test("a generated file is a row with Eneo's name and its size, opened and downloaded on this origin", () => {
  const html = markup(createElement(ResultFiles, { flowId: "flow-1", runId: "run-1", files: [report] }));
  const words = text(html);

  // text() folds the no-break space in "13,3 kB" like any other space.
  assert.match(words, /Nämndmöte till rapport 2026-09-23\.pdf PDF, 13,3 kB/);
  // The module's route names the file from Eneo's response; the page passes no name.
  const inline = "/api/eneo/flows/flow-1/runs/run-1/artifacts/file-1/content?disposition=inline";
  const attachment = "/api/eneo/flows/flow-1/runs/run-1/artifacts/file-1/content?disposition=attachment";
  // Before the window is read it is taken to be a laptop's: the PDF opens in a titled dialog (its trigger here, and its
  // own link to a tab); the phone's link comes with a narrower window (result-document.test.ts).
  const links = tagsOf(html, "a");
  assert.ok(links.some((a) => a.href === inline && a.target === "_blank"), "the dialog's way to a tab of its own");
  assert.ok(links.some((a) => a.href === attachment && "download" in a), "the download saves the file");
  assert.ok(tagsOf(html, "button").some((b) => b["aria-haspopup"] === "dialog" && b["aria-label"] === `Öppna ${report.name}`));
  assert.doesNotMatch(html, /filename=/);
  assert.ok(!html.includes("<iframe"), "the file is fetched only once the dialog is open");
});

test("a Word file downloads; only a PDF offers Öppna", () => {
  const word: ResultFileView = { ...report, fileId: "file-2", name: "Nämndmöte till rapport 2026-09-23.docx", kind: "word", meta: "Word, 85,8\u00a0kB", previewable: false };
  const words = text(markup(createElement(ResultFiles, { flowId: "flow-1", runId: "run-1", files: [word] })));
  assert.doesNotMatch(words, /Öppna/);
  assert.match(words, /Ladda ner/);
});

test("the result names its time like a person, keeps the steps behind plain words and offers a new recording", () => {
  const html = markup(
    createElement(AuthenticatedUserContext.Provider, { value: person }, createElement(RunResult, {
      flowId: "flow-1",
      flowName: "Nämndmöte till rapport",
      run: { id: "run-1", flow_id: "flow-1", status: "completed", created_at: created, finished_at: created, result: { kind: "artifact", files: [] } },
      steps: steps.map((step) => ({ ...step, state: "done" as const })),
      stepResults: [],
      files: [report],
      onNewRecording: () => undefined,
      onRegenerated: () => undefined,
    })),
  );
  const words = text(html);

  assert.match(html, /<h1[^>]*>Dokumentet är klart<\/h1>/);
  assert.match(words, /Skapad (i dag|i går|\d+ \w+) 16:02/);
  assert.match(words, /Hur resultatet togs fram 4 steg/);
  assert.match(words, /Ny inspelning/);
  assert.doesNotMatch(words, /Alla flöden/, "the way back is the page's bar, not the result's own");
  assert.doesNotMatch(html, /eyebrow|uppercase/);
  // The page's frame supplies the one main region and its width; the result is what goes in it.
  assert.doesNotMatch(html, /<main|role="main"/);
});

const resultOf = (run: Record<string, unknown>, files: ResultFileView[] = []) =>
  markup(
    createElement(AuthenticatedUserContext.Provider, { value: person }, createElement(RunResult, {
      flowId: "flow-1",
      flowName: "Nämndmöte till rapport",
      run: { id: "run-1", flow_id: "flow-1", status: "completed", ...run } as never,
      steps: [],
      stepResults: [],
      files,
      showTranscript: false,
      onNewRecording: () => undefined,
      onRegenerated: () => undefined,
    })),
  );

test("a run that sent its result on says so, with no document, and dates itself by when it began if it has no end", () => {
  const sent = resultOf({ created_at: created, result: { kind: "outbound_http" } });
  assert.match(sent, /<h1[^>]*>Resultatet är skickat<\/h1>/);
  assert.doesNotMatch(sent, /aria-label="Dokumentet"/, "nothing to show but the note that it was sent");
  assert.match(text(sent), /Skapad (i dag|i går|\d+ \w+) 16:02/, "finished_at is missing: the start is the time");

  const undated = resultOf({ result: { kind: "outbound_http" } });
  assert.doesNotMatch(text(undated), /Skapad/, "no time at all: none said");
});

test("a failure names the step, says Kördes inte for the rest, keeps the run id copyable and retries only with the same audio", () => {
  const failed = {
    id: "3f1c2a9e-0000-4000-8000-000000000001",
    flow_id: "flow-1",
    status: "failed",
    created_at: created,
    error: { code: "flow_provider_unavailable", message: "Upstream 503", retryable: true, step_order: 2 },
  };
  const render = (onRetry?: () => void) =>
    markup(
      createElement(RunFailure, {
        flowId: "flow-1",
        flowName: "Nämndmöte till rapport",
        run: failed,
        failure: { step: "Steg 2, Analysera mötesinnehållet", summary: "Tjänsten svarade inte eller var överbelastad. Det går bra att köra flödet igen om en stund.", detail: "Upstream 503", inputMustChange: false },
        steps,
        stepResults: [],
        files: [],
        onRetry,
      }),
    );

  const words = text(render(() => undefined));
  // Without the flow's contract nothing says what the run makes: the words stay neutral.
  assert.match(words, /Resultatet kunde inte skapas/);
  assert.match(words, /Steg 2, Analysera mötesinnehållet/);
  assert.match(words, /Skriv sammanfattning Kördes inte/);
  assert.match(words, /Skapa rapport Kördes inte/);
  assert.equal(words.match(/Misslyckades/g)?.length, 1, "only the failed step says Misslyckades");
  assert.match(words, /3f1c2a9e-0000-4000-8000-000000000001/);
  assert.match(words, /Kopiera körnings-ID/);
  assert.match(words, /Försök igen/);
  // The page's own way back is beside the card; the card holds the next step only.
  assert.doesNotMatch(words, /Alla flöden/);
  assert.doesNotMatch(text(render(undefined)), /Försök igen/);
  assert.match(words, /Startad .*16:02/);
  // The callout is a note the heading's focus has already announced, not an alert that interrupts it.
  assert.match(render(undefined), /role="note"/);
  assert.doesNotMatch(render(undefined), /role="alert"/);
});

test("a failure Eneo said nothing about still says what happened, and shows no start time it was not given", () => {
  const html = markup(
    createElement(RunFailure, { flowId: "flow-1", flowName: "Flöde", run: { id: "run-1", status: "failed", error: null }, failure: null, steps: [], stepResults: [], files: [] }),
  );
  const words = text(html);
  assert.match(words, /Körningen kunde inte slutföras Körningen kunde inte slutföras\./, "the callout's title, then its sentence");
  assert.doesNotMatch(words, /Startad/);
  assert.doesNotMatch(words, /Visa teknisk information|Stegen/, "no folded detail without Eneo's, no empty step list");
  assert.match(words, /Kontakta support Körnings-ID run-1 Kopiera körnings-ID/, "the run id to quote, always");
});

test("an Eneo detail with nothing in it offers no folded technical information", () => {
  const html = markup(
    createElement(RunFailure, {
      flowId: "flow-1",
      flowName: "Flöde",
      run: { id: "run-1", status: "failed", error: { code: "x", message: "", retryable: false } },
      failure: { step: null, summary: "Körningen kunde inte slutföras.", detail: "", inputMustChange: false },
      steps,
      stepResults: [],
      files: [],
    }),
  );
  assert.doesNotMatch(html, /teknisk information/);
});

test("the same sentence from a refusal and from a failed new run is said once, not twice", () => {
  const message = "Det gick inte att starta en ny körning just nu.";
  const html = markup(
    createElement(RunFailure, {
      flowId: "flow-1",
      flowName: "Flöde",
      run: { id: "run-1", status: "failed", error: { code: "x", message: "x", retryable: false } },
      failure: null,
      steps,
      stepResults: [],
      files: [],
      refusal: { message, startAgain: true },
      error: message,
    }),
  );
  assert.equal(text(html).split(message).length - 1, 1);
  assert.equal(html.match(/role="alert"/g)?.length, 1);
});

test("a failure the same input cannot pass offers another file as its one filled action, with Eneo's words calm, not red", () => {
  const html = markup(
    createElement(RunFailure, {
      flowId: "flow-1",
      flowName: "Nämndmöte till rapport",
      run: { id: "run-1", status: "failed", created_at: created, error: { code: "typed_io_audio_exceeds_limit", message: "x", retryable: false, step_order: 1 } },
      failure: { step: "Steg 1, Transkribera ljud", summary: "Inspelningen eller filen är längre än flödet klarar.", detail: "x", inputMustChange: true },
      steps,
      stepResults: [],
      files: [],
      onChooseInput: () => undefined,
    }),
  );
  const words = text(html);
  assert.match(words, /Steg 1, Transkribera ljud/);
  assert.match(words, /Välj nytt ljud/, "a recording or a file, whichever it was");
  assert.doesNotMatch(words, /Försök igen|Starta en ny körning|Alla flöden/);
  assert.equal([...html.matchAll(/<button[^>]*data-variant="primary"/g)].length, 1, "one filled action");
  // Eneo's words come as a note, not an alert: the heading's focus has announced the view already.
  assert.match(html, /role="note"(?:(?!<button).)*Inspelningen eller filen är längre/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.match(html, /data-status="warning"/, "a file to change is a warning, not an error");
});

test("earlier runs list this flow's runs by when and status, each one tap from its result", () => {
  const today = new Date();
  today.setHours(10, 12, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  yesterday.setHours(15, 40);
  const opened: string[] = [];
  const html = markup(
    createElement(EarlierRuns, {
      list: listed([
        { id: "run-3", flow_id: "flow-1", status: "running", created_at: today.toISOString() },
        { id: "run-2", flow_id: "flow-1", status: "completed", created_at: yesterday.toISOString() },
        { id: "run-t", flow_id: "flow-1", status: "completed", created_at: yesterday.toISOString(), purpose: "test" },
        { id: "run-1", flow_id: "flow-1", status: "failed", created_at: yesterday.toISOString() },
      ]),
      onOpen: (id: string) => opened.push(id),
    }),
  );
  const words = text(html);

  assert.match(html, /<h2[^>]*>Tidigare körningar<\/h2>/);
  assert.match(words, /I dag 10:12 Pågår Följ/);
  assert.match(words, /I går 15:40 Klar Öppna/);
  assert.match(words, /I går 15:40 Misslyckades Öppna/);
  // Test runs from Eneo's editor are not this user's documents.
  assert.equal(words.match(/I går 15:40/g)?.length, 2);
  assert.equal(markup(createElement(EarlierRuns, { list: listed([]), onOpen: () => undefined })), "");
  const allShown = markup(
    createElement(EarlierRuns, { list: listed([{ id: "run-1", flow_id: "flow-1", status: "completed" }]), onOpen: () => undefined, onMore: () => undefined }),
  );
  assert.doesNotMatch(allShown, /Visa fler körningar/, "no more to show");
});

test("more earlier runs than a page: 'Visa fler körningar' below the list, with its own waiting and failure", () => {
  const run = { id: "run-1", flow_id: "flow-1", status: "completed", created_at: new Date().toISOString() };
  const render = (state: Partial<EarlierRunsSnapshot>) =>
    markup(
      createElement(EarlierRuns, { list: { ...listed([run]), hasMore: true, ...state }, onOpen: () => undefined, onMore: () => undefined }),
    );
  // The design system's button holds its words in a span or two and a live region after them.
  const labelled = (name: string) => new RegExp(`<button[^>]*>(?:<[^>]+>)*${name}(?:<[^>]+>)*</button>`);
  assert.match(render({}), labelled("Visa fler körningar"));
  assert.match(render({ loading: true }), /<button[^>]*disabled=""[^>]*>(?:<[^>]+>)*Hämtar körningar…(?:<[^>]+>)*<\/button>/);
  const failed = render({ failed: "next" });
  assert.match(failed, /Fler körningar kunde inte hämtas\./);
  assert.match(failed, labelled("Visa fler körningar"), "another try");

  // The first page failed: said even with no run shown, with a try again whatever Eneo said about more.
  const firstFailed = markup(
    createElement(EarlierRuns, { list: { ...listed([]), failed: "first" }, onOpen: () => undefined, onMore: () => undefined }),
  );
  assert.match(firstFailed, /Tidigare körningar kunde inte hämtas\./);
  assert.match(firstFailed, labelled("Försök igen"));
});

test("earlier runs ask Eneo for the user's own runs only, never a colleague's", async (t) => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ items: [], count: 0, has_more: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  await listOwnRuns("flow-1", { limit: 10, offset: 0 });
  await listOwnRuns("flow-1", { limit: 10, offset: 10 });

  assert.deepEqual(urls, [
    "/api/eneo/flows/flow-1/runs/?mine=true&limit=10&offset=0",
    "/api/eneo/flows/flow-1/runs/?mine=true&limit=10&offset=10",
  ]);
});

test("folded panels start closed, and the steps' own lines say what is and is not there", () => {
  const failed = markup(
    createElement(RunFailure, {
      flowId: "flow-1",
      flowName: "Flöde",
      run: { id: "run-1", status: "failed", error: { code: "x", message: "detail", retryable: false } },
      failure: { step: null, summary: "Körningen kunde inte slutföras.", detail: "detail", inputMustChange: false },
      steps,
      stepResults: [],
      files: [],
    }),
  );
  const details = markup(createElement(StepDetails, { steps, version: 4 }));
  // What a screen reader hears of a folded panel: its trigger, collapsed. (Whether the content is then out of sight is CSS: tests/e2e.)
  const triggers = (html: string) => [...html.matchAll(/<button[^>]*aria-expanded="(\w+)"[^>]*>(.*?)<\/button>/g)].map(([, expanded, inner]) => [expanded, text(inner)]);
  assert.deepEqual(triggers(details), [["false", "Hur resultatet togs fram 4 steg"]]);
  assert.deepEqual(triggers(failed), [["false", "Visa teknisk information"]]);

  // Nothing to fold: no steps, no panel; a step without a note has no note; no version, no version line.
  assert.equal(markup(createElement(StepDetails, { steps: [], version: 4 })), "");
  assert.doesNotMatch(text(markup(createElement(StepDetails, { steps }))), /Flödets version/);
  assert.match(text(details), /Flödets version 4/);
  const plain = markup(createElement(StepDetails, { steps: [{ order: 1, label: "Transkribera", state: "done", transcribes: true, note: null }] }));
  assert.equal(plain.match(/data-type="supporting"/g)?.length, 2, "the step count and the step's state, no note");
});

test("Försök igen continues where the run stopped; a refusal says why and offers a new run only when that helps", () => {
  const failedRun = { id: "run-1", status: "failed", error: { code: "flow_task_timeout", message: "x", retryable: false, step_order: 2 } };
  const failure = { step: "Steg 2, Analysera mötesinnehållet", summary: "Körningen tog för lång tid.", detail: "x", inputMustChange: false };
  const view = (extra: Record<string, unknown>) =>
    text(
      markup(
        createElement(RunFailure, { flowId: "flow-1", flowName: "Flöde", run: failedRun, failure, steps, stepResults: [], files: [], ...extra }),
      ),
    );

  const offered = view({ onRetry: async () => undefined, onStartAgain: () => undefined });
  assert.match(offered, /Försök igen fortsätter där körningen stannade\. Det som redan blev klart görs inte om\./);
  // Eneo marks this retry as not safe: the button stays secondary, as the advice to check first says.
  const retryButton = (run: typeof failedRun) =>
    markup(
      createElement(RunFailure, { flowId: "flow-1", flowName: "Flöde", run, failure, steps, stepResults: [], files: [], onRetry: async () => undefined }),
    ).match(/<button[^>]*data-variant="(\w+)"[^>]*>(?:(?!<\/button>).)*Försök igen/)![1];
  assert.equal(retryButton(failedRun), "secondary");
  assert.equal(retryButton({ ...failedRun, error: { ...failedRun.error, retryable: true } }), "primary");
  assert.doesNotMatch(offered, /Starta en ny körning/, "a new run is the fallback, not a second choice up front");

  const stale = view({
    onRetry: async () => undefined,
    onStartAgain: () => undefined,
    refusal: { message: "Flödet har ändrats sedan körningen och kan inte fortsätta där den stannade.", startAgain: true },
  });
  assert.match(stale, /Flödet har ändrats sedan körningen/);
  assert.match(stale, /Starta en ny körning/);

  const denied = view({
    onRetry: async () => undefined,
    onStartAgain: () => undefined,
    refusal: { message: "Bara den som startade körningen kan fortsätta den.", startAgain: false },
  });
  assert.match(denied, /Bara den som startade körningen/);
  assert.doesNotMatch(denied, /Starta en ny körning/);

  // Eneo continues only failed runs; after a cancellation the way on is a new run.
  const cancelled = text(
    markup(
      createElement(RunFailure, {
        flowId: "flow-1",
        flowName: "Flöde",
        run: { id: "run-1", status: "cancelled", error: null },
        failure: null,
        steps,
        stepResults: [],
        files: [],
        onStartAgain: () => undefined,
      }),
    ),
  );
  assert.match(cancelled, /Starta en ny körning/);
  assert.match(cancelled, /En ny körning använder samma ljud och uppgifter och gör om alla steg\./);
  assert.doesNotMatch(cancelled, /Försök igen/);
  // A cancellation is not an error: its callout is information, and the one filled action is the new run.
  const cancelledHtml = markup(
    createElement(RunFailure, { flowId: "flow-1", flowName: "Flöde", run: { id: "run-1", status: "cancelled", error: null }, failure: null, steps, stepResults: [], files: [], onStartAgain: () => undefined }),
  );
  assert.match(cancelledHtml, /role="note"[^>]*>(?:(?!<button).)*Körningen stoppades/);
  assert.match(cancelledHtml, /data-status="info"/);
  assert.doesNotMatch(cancelledHtml, /data-status="error"/);
  assert.equal([...cancelledHtml.matchAll(/<button[^>]*data-variant="primary"/g)].length, 1);
});

/**
 * Every button of the markup by what a screen reader hears, and whether it is off. The design system names a button by
 * its `aria-label` where the visible words say less ("Kopiera" for "Kopiera transkriptet").
 */
const buttonsIn = (html: string) =>
  [...html.matchAll(/<button([^>]*)>((?:(?!<\/button>).)*)<\/button>/g)].map(
    ([, attrs, inner]) =>
      [/\saria-label="([^"]*)"/.exec(attrs)?.[1] ?? inner.replace(/<[^>]+>/g, "").trim(), /\sdisabled=""/.test(attrs)] as const,
  );
const exportButtons = (html: string) => buttonsIn(html).filter(([name]) => /^(Kopiera|Ladda ner)/.test(name));
const names = (html: string) => buttonsIn(html).map(([name]) => name);

test("the transcript is not copied or downloaded while its saved corrections could not be read", () => {
  const transcript = {
    pending: false,
    speakerReviews: [],
    correctionProblem: null as string | null,
    segments: [{ fileIndex: 0, start: 0, end: 2, speaker: null, text: "Välkomna till mötet." }],
    fromMetadata: true,
    fileIds: [],
    stepId: "step-1",
    corrections: EMPTY_CORRECTIONS,
    speakerNames: {},
    textPreview: false,
  };
  const editing = {
    corrections: EMPTY_CORRECTIONS,
    saveState: "idle" as const,
    localError: null,
    saveQueue: { current: Promise.resolve(true) },
    onCorrectionsChange: () => undefined,
    retryCorrections: async () => undefined,
    downloadUnsavedCorrections: () => undefined,
  };
  const render = (correctionProblem: string | null) =>
    markup(
      createElement(RunTranscriptView, {
        flowId: "flow-1",
        runId: "run-1",
        fileName: "transkript.txt",
        transcript: { ...transcript, correctionProblem },
        confirmedWords: new Set<string>(),
        editing,
        onReload: () => undefined,
      }),
    );

  const readable = render(null);
  assert.deepEqual(exportButtons(readable), [["Kopiera transkriptet", false], ["Ladda ner som text, transkriptet", false]]);
  assert.ok(!names(readable).includes("Läs in igen"));

  // The hook's own words when reading the saved corrections failed; exporting now would drop them.
  const unread = render("Kunde inte läsa sparade rättningar. Läs in sidan igen innan du redigerar eller godkänner.");
  assert.deepEqual(exportButtons(unread), [["Kopiera transkriptet", true], ["Ladda ner som text, transkriptet", true]]);
  assert.match(unread, /när rättningarna har lästs in/);
  assert.ok(names(unread).includes("Läs in igen"));
});

test("a finished run whose result could not be read says so and offers to read it again, never 'klart'", () => {
  const html = markup(
    createElement(RunUnread, { message: "Servern kunde inte nås just nu. Försök igen om en stund.", onRetry: () => undefined }),
  );
  assert.match(html, /<h1[^>]*>Resultatet kunde inte hämtas<\/h1>/);
  assert.match(html, /Servern kunde inte nås just nu\./);
  // The design system's button holds a live region after its label.
  assert.match(html, /<button[^>]*>(?:(?!<\/button>).)*Försök igen(?:<[^>]+>)*<\/button>/);
  assert.match(html, /href="\/flows"/);
  assert.doesNotMatch(html, /klart|Dokumentet/i);
});

function transcriptView(overrides: Record<string, unknown>) {
  return markup(
    createElement(RunTranscriptView, {
      flowId: "flow-1",
      runId: "run-1",
      fileName: "transkript.txt",
      transcript: {
        pending: false,
        speakerReviews: [],
        correctionProblem: null,
        segments: [{ fileIndex: 0, start: 0, end: 300, speaker: null, text: "Välkomna till mötet." }],
        fromMetadata: false,
        fileIds: [],
        stepId: "step-1",
        corrections: EMPTY_CORRECTIONS,
        speakerNames: {},
        textPreview: false,
        ...overrides,
      } as TranscriptContext,
      confirmedWords: new Set<string>(),
      editing: {
        corrections: EMPTY_CORRECTIONS,
        saveState: "idle" as const,
        localError: null,
        saveQueue: { current: Promise.resolve(true) },
        onCorrectionsChange: () => undefined,
        retryCorrections: async () => undefined,
        downloadUnsavedCorrections: () => undefined,
      },
      onReload: () => undefined,
    }),
  );
}

test("a preview of a longer transcript says so and is neither copied nor downloaded as the whole", () => {
  const html = transcriptView({ textPreview: true });
  assert.match(html, /Förhandsvisning, hela transkriptet kunde inte hämtas/);
  assert.deepEqual(exportButtons(html), [["Kopiera transkriptet", true], ["Ladda ner som text, transkriptet", true]]);
  assert.ok(names(html).includes("Läs in igen"));
});

test("a transcript that could not be read shows why and Läs in igen, even with nothing to show", () => {
  const html = transcriptView({ segments: [], correctionProblem: "Kunde inte läsa transkriptets underlag. Läs in sidan igen innan du godkänner." });
  assert.match(html, /Kunde inte läsa transkriptets underlag/);
  assert.deepEqual(names(html), ["Läs in igen"]);
  assert.equal(transcriptView({ segments: [] }), "", "nothing at all to say: no section");
});

test("a transcript still being read shows only skeletons the screen reader skips", () => {
  const html = transcriptView({ pending: true, segments: [] });
  assert.match(html, /^<div[^>]*aria-hidden="true"/, "hidden from the start");
  assert.deepEqual(names(html), []);
  assert.equal(html.replace(/<[^>]*>/g, ""), "", "no words, no heading");
});
