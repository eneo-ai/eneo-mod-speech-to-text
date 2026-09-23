import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RunProgress } from "../components/flow/RunProgress";
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
