import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ResultFiles } from "../components/flow/ResultFiles";
import { RunFailure } from "../components/flow/RunFailure";
import { RunProgress } from "../components/flow/RunProgress";
import { RunResult } from "../components/flow/RunResult";
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
  name: "Nämndmöte till rapport 2026-09-23",
  downloadName: "Nämndmöte till rapport 2026-09-23.pdf",
  kind: "pdf",
  meta: "PDF, 13,3\u00a0kB",
  available: true,
  previewable: true,
};

test("a generated file is a row with its readable name and size, opened and downloaded on this origin", () => {
  const html = renderToStaticMarkup(createElement(ResultFiles, { flowId: "flow-1", runId: "run-1", files: [report] }));
  const words = text(html);

  // text() folds the no-break space in "13,3 kB" like any other space.
  assert.match(words, /Nämndmöte till rapport 2026-09-23 PDF, 13,3 kB/);
  const inline = "/api/eneo/flows/flow-1/runs/run-1/artifacts/file-1/content?disposition=inline&amp;filename=N%C3%A4mndm%C3%B6te+till+rapport+2026-09-23.pdf";
  const attachment = "/api/eneo/flows/flow-1/runs/run-1/artifacts/file-1/content?disposition=attachment&amp;filename=N%C3%A4mndm%C3%B6te+till+rapport+2026-09-23.pdf";
  // Phones open the PDF in a new tab; wider screens get a titled dialog (its trigger here).
  assert.ok(html.includes(`href="${inline}" target="_blank"`), html);
  assert.match(html, /aria-haspopup="dialog"[^>]*>(?:<[^>]+>)*Öppna/);
  assert.ok(html.includes(`href="${attachment}" download="Nämndmöte till rapport 2026-09-23.pdf"`), html);
  assert.doesNotMatch(html, /step_4_output/);
});

test("a Word file downloads; only a PDF offers Öppna", () => {
  const word: ResultFileView = { ...report, fileId: "file-2", kind: "word", meta: "Word, 85,8\u00a0kB", previewable: false, downloadName: `${report.name}.docx` };
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
  assert.match(words, /Till flödena/);
  assert.doesNotMatch(text(render(undefined)), /Försök igen/);
});
