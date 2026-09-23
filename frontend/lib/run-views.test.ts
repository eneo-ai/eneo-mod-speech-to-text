import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EarlierRuns } from "../components/flow/EarlierRuns";
import type { EarlierRunsSnapshot } from "./earlier-runs";

const listed = (runs: EarlierRunsSnapshot["runs"]): EarlierRunsSnapshot => ({ runs, hasMore: false, loading: false, failed: null });
import { ResultFiles } from "../components/flow/ResultFiles";
import { RunFailure } from "../components/flow/RunFailure";
import { RunProgress, RunUnread } from "../components/flow/RunProgress";
import { RunResult } from "../components/flow/RunResult";
import { StepDetails } from "../components/flow/StepDetails";
import { RunTranscriptView } from "../components/flow/RunTranscript";
import type { TranscriptContext } from "./transcript-context";
import { EMPTY_CORRECTIONS } from "./transcript-corrections";
import { listOwnRuns } from "./api";
import type { ResultFileView } from "./run-files";
import type { StepView } from "./run-progress";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const running: StepView[] = [
  { order: 1, label: "Transkribera mötet", state: "done", transcribes: true },
  { order: 2, label: "Analysera mötesinnehållet", state: "running", transcribes: false },
  { order: 3, label: "Skapa rapport", state: "waiting", transcribes: false },
];

test("the running view names the stage once in a status region and says each step's state in words", () => {
  const html = renderToStaticMarkup(
    createElement(RunProgress, { steps: running, stage: "Analysera mötesinnehållet", onCancel: async () => undefined }),
  );

  assert.match(html, /<h1[^>]*tabindex="-1"[^>]*>Dokumentet skapas<\/h1>/);
  assert.match(html, /role="status"[^>]*>(?:<[^>]+>)*[^<]*Analysera mötesinnehållet/);
  const words = text(html);
  assert.match(words, /Transkribera mötet Klar/);
  assert.match(words, /Analysera mötesinnehållet Pågår/);
  assert.match(words, /Skapa rapport Väntar/);
  assert.doesNotMatch(words, /I kö/);
  assert.match(words, /Du kan stänga sidan\. Körningen fortsätter och resultatet finns kvar här\./);
  assert.match(words, /Avbryt körningen/);
  // The step list is an ordered list, so a screen reader hears position and state.
  assert.match(html, /<ol[^>]*>(\s*<li)/);
});

const created = new Date(2026, 8, 23, 16, 2).toISOString();
const steps: StepView[] = [
  { order: 1, label: "Transkribera mötet", state: "done", transcribes: true },
  { order: 2, label: "Analysera mötesinnehållet", state: "failed", transcribes: false },
  { order: 3, label: "Skriv sammanfattning", state: "not_run", transcribes: false },
  { order: 4, label: "Skapa rapport", state: "not_run", transcribes: false },
];
const report: ResultFileView = {
  fileId: "file-1",
  name: "Nämndmöte till rapport 2026-09-23.pdf",
  kind: "pdf",
  meta: "PDF, 13,3\u00a0kB",
  available: true,
  previewable: true,
};

test("a generated file is a row with Eneo's name and its size, opened and downloaded on this origin", () => {
  const html = renderToStaticMarkup(createElement(ResultFiles, { flowId: "flow-1", runId: "run-1", files: [report] }));
  const words = text(html);

  // text() folds the no-break space in "13,3 kB" like any other space.
  assert.match(words, /Nämndmöte till rapport 2026-09-23\.pdf PDF, 13,3 kB/);
  // The module's route names the file from Eneo's response; the page passes no name.
  const inline = "/api/eneo/flows/flow-1/runs/run-1/artifacts/file-1/content?disposition=inline";
  const attachment = "/api/eneo/flows/flow-1/runs/run-1/artifacts/file-1/content?disposition=attachment";
  // Phones open the PDF in a new tab; wider screens get a titled dialog (its trigger here).
  assert.ok(html.includes(`href="${inline}" target="_blank"`), html);
  assert.match(html, /aria-haspopup="dialog"[^>]*>(?:<[^>]+>)*Öppna/);
  assert.ok(html.includes(`href="${attachment}" download=""`), html);
  assert.doesNotMatch(html, /filename=/);
});

test("a Word file downloads; only a PDF offers Öppna", () => {
  const word: ResultFileView = { ...report, fileId: "file-2", name: "Nämndmöte till rapport 2026-09-23.docx", kind: "word", meta: "Word, 85,8\u00a0kB", previewable: false };
  const words = text(renderToStaticMarkup(createElement(ResultFiles, { flowId: "flow-1", runId: "run-1", files: [word] })));
  assert.doesNotMatch(words, /Öppna/);
  assert.match(words, /Ladda ner/);
});

test("the result names its time like a person, keeps the steps behind Visa stegen and offers a new recording", () => {
  const html = renderToStaticMarkup(
    createElement(RunResult, {
      flowId: "flow-1",
      flowName: "Nämndmöte till rapport",
      run: { id: "run-1", flow_id: "flow-1", status: "completed", created_at: created, finished_at: created, result: { kind: "artifact", files: [] } },
      steps: steps.map((step) => ({ ...step, state: "done" as const })),
      stepResults: [],
      files: [report],
      onNewRecording: () => undefined,
    }),
  );
  const words = text(html);

  assert.match(html, /<h1[^>]*>Dokumentet är klart<\/h1>/);
  assert.match(words, /Skapad (i dag|i går|\d+ \w+) 16:02/);
  assert.match(words, /Visa stegen \(4\)/);
  assert.match(words, /Ny inspelning/);
  assert.match(words, /Till flödena/);
  assert.doesNotMatch(html, /eyebrow|uppercase/);
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
    renderToStaticMarkup(
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
  assert.match(words, /Dokumentet kunde inte skapas/);
  assert.match(words, /Steg 2, Analysera mötesinnehållet/);
  assert.match(words, /Skriv sammanfattning Kördes inte/);
  assert.match(words, /Skapa rapport Kördes inte/);
  assert.equal(words.match(/Misslyckades/g)?.length, 1, "only the failed step says Misslyckades");
  assert.match(words, /3f1c2a9e-0000-4000-8000-000000000001/);
  assert.match(words, /Kopiera körnings-ID/);
  assert.match(words, /Försök igen/);
  assert.match(words, /Alla flöden/);
  assert.doesNotMatch(text(render(undefined)), /Försök igen/);
});

test("earlier runs list this flow's runs by when and status, each one tap from its result", () => {
  const today = new Date();
  today.setHours(10, 12, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  yesterday.setHours(15, 40);
  const opened: string[] = [];
  const html = renderToStaticMarkup(
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
  assert.equal(renderToStaticMarkup(createElement(EarlierRuns, { list: listed([]), onOpen: () => undefined })), "");
  const allShown = renderToStaticMarkup(
    createElement(EarlierRuns, { list: listed([{ id: "run-1", flow_id: "flow-1", status: "completed" }]), onOpen: () => undefined, onMore: () => undefined }),
  );
  assert.doesNotMatch(allShown, /Visa fler körningar/, "no more to show");
});

test("more earlier runs than a page: 'Visa fler körningar' below the list, with its own waiting and failure", () => {
  const run = { id: "run-1", flow_id: "flow-1", status: "completed", created_at: new Date().toISOString() };
  const render = (state: Partial<EarlierRunsSnapshot>) =>
    renderToStaticMarkup(
      createElement(EarlierRuns, { list: { ...listed([run]), hasMore: true, ...state }, onOpen: () => undefined, onMore: () => undefined }),
    );
  assert.match(render({}), />Visa fler körningar<\/button>/);
  assert.match(render({ loading: true }), /<button[^>]*disabled=""[^>]*>Hämtar körningar…<\/button>/);
  const failed = render({ failed: "next" });
  assert.match(failed, /Fler körningar kunde inte hämtas\./);
  assert.match(failed, />Visa fler körningar<\/button>/, "another try");

  // The first page failed: said even with no run shown, with a try again whatever Eneo said about more.
  const firstFailed = renderToStaticMarkup(
    createElement(EarlierRuns, { list: { ...listed([]), failed: "first" }, onOpen: () => undefined, onMore: () => undefined }),
  );
  assert.match(firstFailed, /Tidigare körningar kunde inte hämtas\./);
  assert.match(firstFailed, />Försök igen<\/button>/);
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

test("folded panels stay hidden: no display utility may override the closed content's hidden attribute", () => {
  const html = [
    renderToStaticMarkup(createElement(StepDetails, { steps, version: 4 })),
    renderToStaticMarkup(
      createElement(RunFailure, {
        flowId: "flow-1",
        flowName: "Flöde",
        run: { id: "run-1", status: "failed", error: { code: "x", message: "detail", retryable: false } },
        failure: { step: null, summary: "Körningen kunde inte slutföras.", detail: "detail", inputMustChange: false },
        steps,
        stepResults: [],
        files: [],
      }),
    ),
  ].join("");
  const closed = [...html.matchAll(/<div([^>]*\shidden=""[^>]*)>/g)].map((m) => m[1]);
  assert.ok(closed.length >= 2, "both folded panels render closed");
  for (const attributes of closed) assert.doesNotMatch(attributes, /class="[^"]*\b(flex|grid|block|inline-flex)\b/, attributes);
});

test("Försök igen continues where the run stopped; a refusal says why and offers a new run only when that helps", () => {
  const failedRun = { id: "run-1", status: "failed", error: { code: "flow_task_timeout", message: "x", retryable: false, step_order: 2 } };
  const failure = { step: "Steg 2, Analysera mötesinnehållet", summary: "Körningen tog för lång tid.", detail: "x", inputMustChange: false };
  const view = (extra: Record<string, unknown>) =>
    text(
      renderToStaticMarkup(
        createElement(RunFailure, { flowId: "flow-1", flowName: "Flöde", run: failedRun, failure, steps, stepResults: [], files: [], ...extra }),
      ),
    );

  const offered = view({ onRetry: async () => undefined, onStartAgain: () => undefined });
  assert.match(offered, /Försök igen fortsätter där körningen stannade\. Det som redan blev klart görs inte om\./);
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
    renderToStaticMarkup(
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
});

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
    renderToStaticMarkup(
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
  const exportButtons = (html: string) =>
    [...html.matchAll(/<button([^>]*)>(?:(?!<\/button>).)*?(Kopiera transkriptet|Ladda ner)/g)].map(([, attrs, label]) => [
      label,
      /\sdisabled=""/.test(attrs),
    ]);

  const readable = render(null);
  assert.deepEqual(exportButtons(readable), [["Kopiera transkriptet", false], ["Ladda ner", false]]);
  assert.doesNotMatch(readable, />Läs in igen</);

  // The hook's own words when reading the saved corrections failed; exporting now would drop them.
  const unread = render("Kunde inte läsa sparade rättningar. Läs in sidan igen innan du redigerar eller godkänner.");
  assert.deepEqual(exportButtons(unread), [["Kopiera transkriptet", true], ["Ladda ner", true]]);
  assert.match(unread, /när rättningarna har lästs in/);
  assert.match(unread, /<button[^>]*>(?:(?!<\/button>).)*Läs in igen<\/button>/);
});

test("a finished run whose result could not be read says so and offers to read it again, never 'klart'", () => {
  const html = renderToStaticMarkup(
    createElement(RunUnread, { message: "Servern kunde inte nås just nu. Försök igen om en stund.", onRetry: () => undefined }),
  );
  assert.match(html, /<h1[^>]*>Resultatet kunde inte hämtas<\/h1>/);
  assert.match(html, /Servern kunde inte nås just nu\./);
  assert.match(html, /<button[^>]*>(?:(?!<\/button>).)*Försök igen<\/button>/);
  assert.match(html, /href="\/flows"/);
  assert.doesNotMatch(html, /klart|Dokumentet/i);
});

function transcriptView(overrides: Record<string, unknown>) {
  return renderToStaticMarkup(
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
  assert.match(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Kopiera transkriptet/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Ladda ner/);
  assert.match(html, />Läs in igen</);
});

test("a transcript that could not be read shows why and Läs in igen, even with nothing to show", () => {
  const html = transcriptView({ segments: [], correctionProblem: "Kunde inte läsa transkriptets underlag. Läs in sidan igen innan du godkänner." });
  assert.match(html, /Kunde inte läsa transkriptets underlag/);
  assert.match(html, /<button[^>]*>(?:(?!<\/button>).)*Läs in igen<\/button>/);
  assert.equal(transcriptView({ segments: [] }), "", "nothing at all to say: no section");
});
