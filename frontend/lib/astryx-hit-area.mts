/**
 * Under a finger, Astryx grows each control's target toward 44 px without reaching into a neighbour. To find the
 * neighbours, a pass of its hit areas (utils/hitArea.js) reads the box of every interactive element on the page,
 * whichever control is due. A long transcript holds thousands of buttons in 57,000 elements, in passages laid out only
 * near the window (`content-visibility: auto`). Two changes keep that read short on a phone:
 *
 * - An element whose rendering is skipped is off screen, so it can be neither touched nor a neighbour of a control on
 *   screen, and the read leaves it out. Reading those boxes laid out passages off screen: one key in the transcript's
 *   search took seconds.
 * - A pass keeps the page's interactive elements from the last read until a change can alter which they are. Astryx
 *   counts every change to an attribute its selector reads as one; here a change to an attribute that leaves its element
 *   taking taps as before (a tab list moving its roving tabindex, a control setting its own type again) keeps the list.
 *   Finding them all again made the pass after the tab Transkribering a task of 65 to 75 ms on a laptop with the
 *   phone's slowed processor; keeping them, 10 ms.
 *
 * The build and the dev server's prebundle both apply it (vite.config.mts). A release in which a patched line is not
 * there once fails the build, so the change is looked at again on every upgrade.
 */
import type { Plugin } from "vite";

const FILE = /\/@astryxdesign\/core\/dist\/utils\/hitArea\.js$/;
const PATCHES: [line: string, replacement: string][] = [
  [
    "return interactiveElements(doc).map(element => ({",
    "return interactiveElements(doc).filter(element => element.checkVisibility?.({ contentVisibilityAuto: true }) !== false).map(element => ({",
  ],
  // What the last read found matches the selector; the list stays while every change leaves that as it was.
  ["let interactive = null;", "let interactive = null, matched = new WeakSet();"],
  [
    "  for (const found of doc.querySelectorAll(INTERACTIVE_SELECTOR)) {",
    "  matched = new WeakSet();\n  for (const found of doc.querySelectorAll(INTERACTIVE_SELECTOR)) {\n    matched.add(found);",
  ],
  [
    "observeMutations(doc, CANDIDATE_MUTATIONS, forgetInteractive);",
    "observeMutations(doc, CANDIDATE_MUTATIONS, records => records.every(record => record.type === 'attributes' && record.target.matches(INTERACTIVE_SELECTOR) === matched.has(record.target)) || forgetInteractive());",
  ],
];

export function patchHitArea(code: string): string {
  return PATCHES.reduce((patched, [line, replacement]) => {
    if (patched.split(line).length !== 2)
      throw new Error(`@astryxdesign/core/dist/utils/hitArea.js no longer has \`${line.trim()}\` once, as lib/astryx-hit-area.mts expects: look again`);
    return patched.replace(line, replacement);
  }, code);
}

export function astryxHitArea(): Plugin {
  return {
    name: "astryx-hit-area",
    transform: (code, id) => (FILE.test(id) ? patchHitArea(code) : undefined),
  };
}
