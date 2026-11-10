import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { astryxHitArea, patchHitArea } from "./astryx-hit-area.mjs";
import { installDom } from "./test-dom";

const FILE = "node_modules/@astryxdesign/core/dist/utils/hitArea.js";
const INSTALLED = readFileSync(FILE, "utf8");
const transform = (code: string, id: string) => (astryxHitArea().transform as (code: string, id: string) => string | undefined)(code, id);

test("the installed Astryx reads every interactive element's box in one place, which the build narrows to the rendered ones", () => {
  const patched = patchHitArea(INSTALLED);
  assert.notEqual(patched, INSTALLED);
  assert.match(patched, /checkVisibility\?\.\(\{ contentVisibilityAuto: true \}\) !== false/);
  // Three lines change and two are added (the read's record of what it found), and nothing else.
  const added = ["  matched = new WeakSet();", "    matched.add(found);"];
  const [before, after] = [INSTALLED.split("\n"), patched.split("\n").filter((line) => !added.includes(line))];
  assert.equal(patched.split("\n").length, before.length + added.length);
  assert.equal(after.length, before.length);
  assert.equal(before.filter((line, i) => line !== after[i]).length, 3);
});

test("a pass reads the page's elements again after a change to which take taps, and not after an attribute that changes none", async () => {
  installDom();
  // The patched module, beside the one module it imports, as the build bundles it.
  const dir = mkdtempSync(join(tmpdir(), "astryx-hit-area-"));
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }');
  writeFileSync(join(dir, "hitArea.js"), patchHitArea(INSTALLED));
  copyFileSync(FILE.replace("hitArea.js", "sharedMutationObserver.js"), join(dir, "sharedMutationObserver.js"));
  const { watchHitArea, resetHitAreaForTests } = (await import(join(dir, "hitArea.js"))) as {
    watchHitArea: (element: Element, onInsets: () => void) => () => void;
    resetHitAreaForTests: () => void;
  };
  // A touch screen, and frames that run when the test says.
  const touch = (query: string) => ({ matches: query === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
  Object.assign(window, { matchMedia: touch });
  const frames: FrameRequestCallback[] = [];
  Object.assign(globalThis, { requestAnimationFrame: (frame: FrameRequestCallback) => frames.push(frame) });
  document.body.innerHTML = '<button id="control">A</button><button id="neighbour">B</button><p id="text">C</p>';
  let reads = 0;
  const query = document.querySelectorAll.bind(document);
  document.querySelectorAll = ((selector: string) => (reads++, query(selector))) as typeof document.querySelectorAll;
  // A pass, as a resize of the window starts one for every control.
  const pass = async () => {
    await Promise.resolve();
    window.dispatchEvent(new window.Event("resize"));
    for (const frame of frames.splice(0)) frame(0);
  };
  try {
    const stop = watchHitArea(document.getElementById("control")!, () => {});
    await pass();
    assert.equal(reads, 1, "the first pass reads the page");
    // A tab list moves its roving tabindex; a control sets its own type again. Each still takes taps.
    document.getElementById("neighbour")!.setAttribute("tabindex", "-1");
    document.getElementById("neighbour")!.setAttribute("type", "button");
    await pass();
    assert.equal(reads, 1, "nothing that takes taps changed: the pass keeps what it read");
    document.getElementById("text")!.setAttribute("role", "button");
    await pass();
    assert.equal(reads, 2, "a paragraph that became a button is read");
    document.getElementById("text")!.removeAttribute("role");
    await pass();
    assert.equal(reads, 3, "and one that is a paragraph again is left out");
    document.body.append(document.createElement("button"));
    await pass();
    assert.equal(reads, 4, "an element added or removed reads the page again");
    stop();
  } finally {
    resetHitAreaForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a release without that read fails the build instead of shipping the slow read unnoticed", () => {
  assert.throws(() => patchHitArea("export function readCandidates() {}"), /hitArea\.js/);
});

test("the build changes Astryx's hit-area module and nothing else", () => {
  assert.equal(transform(INSTALLED, `/x/frontend/${FILE}`), patchHitArea(INSTALLED));
  assert.equal(transform(INSTALLED, "/x/frontend/node_modules/@astryxdesign/core/dist/utils/touchHitArea.js"), undefined);
  assert.equal(transform("const a = 1;", "/x/frontend/lib/drafts.ts"), undefined);
});
