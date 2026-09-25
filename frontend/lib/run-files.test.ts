import assert from "node:assert/strict";
import test from "node:test";

import type { FlowRunStep, ResultFile } from "./api";
import { fileText, resultFileViews, transcriptFileName } from "./run-files";

const pdf: ResultFile = {
  file_id: "f1",
  name: "Nämndmöte till rapport 2026-09-23.pdf",
  mimetype: "application/pdf",
  size: 13_619,
  availability: "available",
};

test("a generated file shows Eneo's own name as is, with its type and size in Swedish", () => {
  const [file] = resultFileViews([pdf]);

  assert.equal(file.name, "Nämndmöte till rapport 2026-09-23.pdf");
  assert.equal(file.meta, "PDF, 13,3 kB");
  assert.equal(file.kind, "pdf");
  assert.equal(file.previewable, true);
  assert.equal(file.available, true);
});

test("the page makes no name of its own: whatever Eneo sends is what people see", () => {
  const files = resultFileViews([
    { ...pdf, name: "step_4_output.pdf" },
    { ...pdf, file_id: "f2", name: "step_4_output.pdf" },
    { file_id: "f3", name: "beslut.docx", mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 87_859 },
    { file_id: "f4", name: "transkript", mimetype: "text/plain; charset=utf-8" },
    { file_id: "f5", mimetype: "application/pdf" },
  ]);

  assert.deepEqual(files.map((f) => f.name), ["step_4_output.pdf", "step_4_output.pdf", "beslut.docx", "transkript", "Fil"]);
  assert.deepEqual(files.map((f) => f.meta), ["PDF, 13,3 kB", "PDF, 13,3 kB", "Word, 85,8 kB", "Text", "PDF"]);
  // Only a PDF opens in the browser's own viewer; Word downloads.
  assert.deepEqual(files.map((f) => f.previewable), [true, true, false, false, true]);
});

test("a purged file stays listed but offers nothing to open", () => {
  const [file] = resultFileViews([{ ...pdf, availability: "content_purged" }]);
  assert.equal(file.available, false);
  assert.equal(file.previewable, false);
  assert.equal(file.meta, "Filen har tagits bort.");
});

test("the module's own transcript export is named the way Eneo names documents", () => {
  assert.equal(transcriptFileName('Möte: "budget" 2/3?', "2026-09-23T14:02:01Z"), "Möte budget 2 3 2026-09-23 transkript.txt");
  // Eneo dates a document by the run's day in UTC, so the export keeps that day too.
  assert.equal(transcriptFileName("Nämndmöte", "2026-09-23T23:30:00+00:00"), "Nämndmöte 2026-09-23 transkript.txt");
  assert.equal(transcriptFileName("", undefined), "transkript.txt");
});

test("a document's file says what its own step wrote: Eneo lays that text out in the file", () => {
  const [file] = resultFileViews([{ ...pdf, step_id: "s2" }]);
  assert.equal(file.stepId, "s2");
  const transcribe: FlowRunStep = { id: "r1", step_id: "s1", status: "completed", output_payload_json: { text: "Transkript" } };
  // The step read the transcript and wrote the report; the report is what the file says.
  const report: FlowRunStep = {
    id: "r2", step_id: "s2", status: "completed",
    input_payload_json: { runtime_input: { text: "Transkript" } },
    output_payload_json: { text: "## Protokoll\n\nBeslut." },
  };
  assert.equal(fileText(file, [transcribe, report]), "## Protokoll\n\nBeslut.");

  // No reliable text, no preview.
  const other = (output: object, extra: object = {}) => fileText(file, [transcribe, { ...report, output_payload_json: output, ...extra }]);
  assert.equal(other({ text: '{"beslut":"Ja"}', structured: { beslut: "Ja" } }), null, "laid out from fields, not from the text");
  assert.equal(other({ text: "## Protokoll", text_overflow: { generated_file_ids: ["f9"] } }), null, "only the start of a longer text");
  assert.equal(other({ text: "## beslut\n\nJa" }, { model_parameters_json: { mode: "template_fill" } }), null, "a filled template lists its fields");
  assert.equal(other({ text: " \n" }), null, "nothing written");
  assert.equal(fileText({ ...file, stepId: null }, [transcribe, report]), null, "no step named: no guess from another step");
});
