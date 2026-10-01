import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// What the port to the design system removes: the copied shadcn components and their helpers, and class strings
// (Tailwind's). A ported file styles through the design system's props, or a CSS Module (className={styles.x}).
const LEGACY = /from "(?:@\/components\/ui\/|@radix-ui\/|class-variance-authority"|tailwind-merge"|@\/lib\/utils")|className=(?:"|\{`|\{cn\()/;

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === join("components", "ui") ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

test("the files still on the old UI system are the listed ones, and the list only shrinks", () => {
  const listed: string[] = JSON.parse(readFileSync("tests/legacy-ui-files.json", "utf8"));
  const legacy = ["app", "components", "kit"].flatMap(sources).filter((file) => LEGACY.test(readFileSync(file, "utf8"))).sort();
  assert.deepEqual(legacy.filter((file) => !listed.includes(file)), [], "not on the list and on the old system: port it, do not list it");
  assert.deepEqual(listed.filter((file) => !legacy.includes(file)), [], "ported: remove from tests/legacy-ui-files.json");
});
