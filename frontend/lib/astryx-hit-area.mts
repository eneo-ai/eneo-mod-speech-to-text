/**
 * Under a finger, Astryx grows each control's target toward 44 px without reaching into a neighbour. To find the
 * neighbours, every pass of its hit areas (utils/hitArea.js) reads the box of every interactive element on the page,
 * whichever control is due. A long transcript holds thousands of buttons in passages laid out only near the window
 * (`content-visibility: auto`), and each read lays out a passage off screen: one key in its search took seconds on a
 * phone. An element whose rendering is skipped is off screen, so it can be neither touched nor a neighbour of a control
 * on screen, and the read leaves it out.
 *
 * The build and the dev server's prebundle both apply it (vite.config.mts). A release without the line fails the build,
 * so the change is looked at again on every upgrade.
 */
import type { Plugin } from "vite";

const FILE = /\/@astryxdesign\/core\/dist\/utils\/hitArea\.js$/;
const READ = "return interactiveElements(doc).map(element => ({";
const RENDERED = "return interactiveElements(doc).filter(element => element.checkVisibility?.({ contentVisibilityAuto: true }) !== false).map(element => ({";

export function patchHitArea(code: string): string {
  if (code.split(READ).length !== 2) throw new Error(`@astryxdesign/core/dist/utils/hitArea.js no longer reads its candidates as lib/astryx-hit-area.mts expects: look again`);
  return code.replace(READ, RENDERED);
}

export function astryxHitArea(): Plugin {
  return {
    name: "astryx-hit-area",
    transform: (code, id) => (FILE.test(id) ? patchHitArea(code) : undefined),
  };
}
