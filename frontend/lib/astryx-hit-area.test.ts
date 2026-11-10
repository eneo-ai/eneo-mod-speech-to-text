import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { astryxHitArea, patchHitArea } from "./astryx-hit-area.mjs";

const FILE = "node_modules/@astryxdesign/core/dist/utils/hitArea.js";
const INSTALLED = readFileSync(FILE, "utf8");
const transform = (code: string, id: string) => (astryxHitArea().transform as (code: string, id: string) => string | undefined)(code, id);

test("the installed Astryx reads every interactive element's box in one place, which the build narrows to the rendered ones", () => {
  const patched = patchHitArea(INSTALLED);
  assert.notEqual(patched, INSTALLED);
  assert.match(patched, /checkVisibility\?\.\(\{ contentVisibilityAuto: true \}\) !== false/);
  // One line changes, and only that one.
  const [before, after] = [INSTALLED.split("\n"), patched.split("\n")];
  assert.equal(after.length, before.length);
  assert.equal(before.filter((line, i) => line !== after[i]).length, 1);
});

test("a release without that read fails the build instead of shipping the slow read unnoticed", () => {
  assert.throws(() => patchHitArea("export function readCandidates() {}"), /hitArea\.js/);
});

test("the build changes Astryx's hit-area module and nothing else", () => {
  assert.equal(transform(INSTALLED, `/x/frontend/${FILE}`), patchHitArea(INSTALLED));
  assert.equal(transform(INSTALLED, "/x/frontend/node_modules/@astryxdesign/core/dist/utils/touchHitArea.js"), undefined);
  assert.equal(transform("const a = 1;", "/x/frontend/lib/drafts.ts"), undefined);
});
