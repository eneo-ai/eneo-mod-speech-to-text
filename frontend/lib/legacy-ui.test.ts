import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The first UI system (shadcn on Radix and Tailwind) is gone, and stays gone: no module imports what it was made of
// (the copied components and their helpers, Radix, class-variance-authority, clsx, tailwind-merge) and none styles
// with a class string, which was Tailwind's. A module styles through the design system's props, or a CSS Module
// (className={styles.x}).
const GONE = /from "(?:@\/components\/ui\/|@radix-ui\/|class-variance-authority"|clsx"|tailwind-merge"|tailwindcss|@\/lib\/utils")/;
const CLASS_STRING = /className=(?:"|\{`|\{cn\()/;

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

test("the old UI system stays gone: no import of what it was made of, no class string", () => {
  const files = ["app", "components", "kit", "lib"].flatMap(sources).filter((file) => !file.endsWith("legacy-ui.test.ts"));
  assert.deepEqual(files.filter((file) => GONE.test(readFileSync(file, "utf8"))), [], "an import of the removed UI libraries");
  assert.deepEqual(files.filter((file) => CLASS_STRING.test(readFileSync(file, "utf8"))), [], "a class string: use the design system's props or a CSS Module");
});
