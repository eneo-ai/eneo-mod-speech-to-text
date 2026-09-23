import assert from "node:assert/strict";
import test from "node:test";

import type { ResultFile } from "./api";
import { readableBaseName, resultFileViews } from "./run-files";

const created = new Date(2026, 8, 23, 16, 2).toISOString();
const pdf: ResultFile = { file_id: "f1", name: "step_4_output.pdf", mimetype: "application/pdf", size: 13_619, availability: "available" };

test("a generated file is named after the flow and the day, with its type and size in Swedish", () => {
  const [file] = resultFileViews([pdf], "Nämndmöte till rapport", created);

  assert.equal(file.name, "Nämndmöte till rapport 2026-09-23");
  assert.equal(file.downloadName, "Nämndmöte till rapport 2026-09-23.pdf");
  assert.equal(file.meta, "PDF, 13,3 kB");
  assert.equal(file.kind, "pdf");
  assert.equal(file.previewable, true);
  assert.equal(file.available, true);
});

test("several files of one run get distinct names; Word downloads, never previews", () => {
  const files = resultFileViews(
    [
      pdf,
      { ...pdf, file_id: "f2", name: "step_5_output.pdf" },
      { file_id: "f3", name: "beslut.docx", mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 87_859 },
      { file_id: "f4", name: "transkript", mimetype: "text/plain; charset=utf-8" },
    ],
    "Nämndmöte till rapport",
    created,
  );

  assert.deepEqual(files.map((f) => f.downloadName), [
    "Nämndmöte till rapport 2026-09-23.pdf",
    "Nämndmöte till rapport 2026-09-23 (2).pdf",
    "Nämndmöte till rapport 2026-09-23.docx",
    "Nämndmöte till rapport 2026-09-23.txt",
  ]);
  assert.deepEqual(files.map((f) => f.meta), ["PDF, 13,3 kB", "PDF, 13,3 kB", "Word, 85,8 kB", "Text"]);
  assert.deepEqual(files.map((f) => f.previewable), [true, true, false, false]);
});

test("a purged file stays listed but offers nothing to open", () => {
  const [file] = resultFileViews([{ ...pdf, availability: "content_purged" }], "Flöde", created);
  assert.equal(file.available, false);
  assert.equal(file.previewable, false);
  assert.equal(file.meta, "Filen har tagits bort.");
});

test("a flow name keeps only characters a file name can carry", () => {
  assert.equal(readableBaseName('Möte: "budget" 2/3?', created), "Möte budget 2 3 2026-09-23");
  assert.equal(readableBaseName("", created), "Dokument 2026-09-23");
});
