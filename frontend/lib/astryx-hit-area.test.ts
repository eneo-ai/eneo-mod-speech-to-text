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

test("the installed Astryx has each line the build changes, once", () => {
  const patched = patchHitArea(INSTALLED);
  assert.notEqual(patched, INSTALLED);
  assert.match(patched, /checkVisibility\?\.\(\{ contentVisibilityAuto: true \}\) !== false/);
  assert.doesNotMatch(patched, /forgetInteractive\(\);\n    entry\.watches\.add/);
});

test("a pass reads only the part of the page that changed which elements take taps, and finds them as neighbours", async () => {
  installDom();
  // The patched module, beside the one module it imports, as the build bundles it.
  const dir = mkdtempSync(join(tmpdir(), "astryx-hit-area-"));
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }');
  writeFileSync(join(dir, "hitArea.js"), patchHitArea(INSTALLED));
  copyFileSync(FILE.replace("hitArea.js", "sharedMutationObserver.js"), join(dir, "sharedMutationObserver.js"));
  const { watchHitArea, resetHitAreaForTests } = (await import(join(dir, "hitArea.js"))) as {
    watchHitArea: (element: Element, onInsets: (insets: object) => void) => () => void;
    resetHitAreaForTests: () => void;
  };
  // A touch screen, and frames that run when the test says.
  const touch = (query: string) => ({ matches: query === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
  Object.assign(window, { matchMedia: touch });
  const frames: FrameRequestCallback[] = [];
  Object.assign(globalThis, { requestAnimationFrame: (frame: FrameRequestCallback) => frames.push(frame) });
  // Boxes by a data attribute, "left top width height": a 20 px control at the corner, the rest where they are put.
  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const [left, top, width, height] = (this.getAttribute("data-box") ?? "0 0 0 0").split(" ").map(Number);
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} } as DOMRect;
  };
  document.body.innerHTML =
    '<button id="control" data-box="0 0 20 20">A</button><button id="far" data-box="300 300 20 20">B</button><p id="text" data-box="24 0 20 20">C</p>';
  let reads = 0;
  const query = document.querySelectorAll.bind(document);
  document.querySelectorAll = ((selector: string) => (reads++, query(selector))) as typeof document.querySelectorAll;
  let insets = "";
  // A pass, as a resize of the window starts one for every control.
  const pass = async () => {
    await Promise.resolve();
    window.dispatchEvent(new window.Event("resize"));
    for (const frame of frames.splice(0)) frame(0);
    return insets;
  };
  try {
    const stop = watchHitArea(document.getElementById("control")!, (next) => (insets = JSON.stringify(next)));
    const alone = await pass();
    assert.equal(reads, 1, "the first pass reads the page");
    // A tab list moves its roving tabindex; a control sets its own type again; a search marks a word. Each changes nothing
    // that takes taps.
    document.getElementById("far")!.setAttribute("tabindex", "-1");
    document.getElementById("far")!.setAttribute("type", "button");
    document.getElementById("text")!.append(document.createElement("mark"));
    assert.equal(await pass(), alone);
    // A paragraph beside the control becomes a button, and is one no more.
    document.getElementById("text")!.setAttribute("role", "button");
    const beside = await pass();
    assert.notEqual(beside, alone, "the paragraph that became a button is the control's neighbour");
    document.getElementById("text")!.removeAttribute("role");
    assert.equal(await pass(), alone, "and is not once it is a paragraph again");
    // A button added beside the control, inside an added part, and removed again.
    const part = document.createElement("section");
    part.innerHTML = '<button data-box="24 0 20 20">D</button>';
    document.body.append(part);
    assert.equal(await pass(), beside, "the added button is the control's neighbour");
    part.remove();
    assert.equal(await pass(), alone, "the removed one is not");
    // A control beside the first whose input is elsewhere: watched, it counts by its own box; let go, by its input again.
    const toggle = document.createElement("span");
    toggle.setAttribute("data-box", "24 0 20 20");
    toggle.innerHTML = '<input type="checkbox" data-box="200 0 5 5">';
    document.body.append(toggle);
    assert.equal(await pass(), alone, "its input is far from the control");
    const release = watchHitArea(toggle, () => {});
    assert.equal(await pass(), beside, "watched, it is the control's neighbour");
    release();
    assert.equal(await pass(), alone, "let go, it is not");
    assert.equal(reads, 1, "none of it read the whole page again");
    stop();
  } finally {
    Element.prototype.getBoundingClientRect = rect;
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
