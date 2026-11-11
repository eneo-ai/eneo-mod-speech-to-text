/**
 * Under a finger, Astryx grows each control's target toward 44 px without reaching into a neighbour. To find the
 * neighbours, a pass of its hit areas (utils/hitArea.js) reads the box of every interactive element on the page,
 * whichever control is due. A long transcript holds thousands of buttons in 57,000 elements, in passages laid out only
 * near the window (`content-visibility: auto`). Two changes keep that read short on a phone:
 *
 * - An element whose rendering is skipped is off screen, so it can be neither touched nor a neighbour of a control on
 *   screen, and the read leaves it out. Reading those boxes laid out passages off screen: one key in the transcript's
 *   search took seconds.
 * - A pass keeps the page's interactive elements from the last read and, after a change, reads again only the part of
 *   the page that changed. Astryx finds them all again after any change: an element added or removed anywhere, a
 *   control watched or let go, an attribute its selector reads. Finding 6,000 in 57,000 elements took 72 ms with the
 *   processor slowed 6 times, in a 105 ms pass after the first key in the search (which brings the clear button and
 *   the search's Föregående and Nästa). Here an attribute that leaves its element taking taps as before, and an element
 *   added or removed with no interactive element in it (a search's highlight), change nothing; anything else reads
 *   that part again.
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
  // `matched`: what the last read found matching the selector. `stale`: the parts of the page changed since, which the
  // next pass reads again in place of the whole page.
  [
    "let interactive = null;",
    "let interactive = null, matched = new WeakSet(), stale = new Set();\nconst touched = root => { if (interactive != null) stale.add(root); };",
  ],
  [
    "  for (const found of doc.querySelectorAll(INTERACTIVE_SELECTOR)) {",
    "  matched = new WeakSet();\n  stale.clear();\n  for (const found of doc.querySelectorAll(INTERACTIVE_SELECTOR)) {\n    matched.add(found);",
  ],
  // A change leaves the list as it was, or marks the part it changed.
  [
    "observeMutations(doc, CANDIDATE_MUTATIONS, forgetInteractive);",
    "observeMutations(doc, CANDIDATE_MUTATIONS, records => { for (const record of records) { if (record.type === 'attributes') { if (record.target.matches(INTERACTIVE_SELECTOR) !== matched.has(record.target)) touched(record.target); continue; } for (const node of record.addedNodes) if (node.nodeType === 1 && (node.matches(INTERACTIVE_SELECTOR) || node.querySelector(INTERACTIVE_SELECTOR))) touched(node); for (const node of record.removedNodes) if (node.nodeType === 1 && (matched.has(node) || node.querySelector(INTERACTIVE_SELECTOR))) touched(node); } });",
  ],
  // The list less what was in a changed part or left the page, and what a changed part holds now, by its control. Each
  // element looks up its own ancestors once, so many changed parts cost no more than a few.
  [
    "  if (interactive != null) {",
    "  if (interactive != null && stale.size > 0) {\n    const changed = new Set([...stale].filter(root => root.isConnected));\n    stale.clear();\n    const within = node => { for (; node != null; node = node.parentElement) if (changed.has(node)) return true; return false; };\n    const roots = [...changed].filter(root => !within(root.parentElement));\n    const kept = new Set(interactive.filter(element => element.isConnected && !within(element)));\n    for (const root of roots) {\n      matched.delete(root);\n      for (const found of [...(root.matches(INTERACTIVE_SELECTOR) ? [root] : []), ...root.querySelectorAll(INTERACTIVE_SELECTOR)]) {\n        matched.add(found);\n        kept.add(watchedOwner(found) ?? found);\n      }\n    }\n    interactive = [...kept];\n  }\n  if (interactive != null) {",
  ],
  // A control watched or let go: its parts count by it, or by themselves again.
  ["    watched.set(element, entry);\n    forgetInteractive();", "    watched.set(element, entry);\n    touched(element);"],
  ["      watched.delete(element);\n      forgetInteractive();", "      watched.delete(element);\n      touched(element);"],
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
