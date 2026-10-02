import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

// What the flow list loads for every visit: the modules its page and the root layout import, followed statically
// (an `import()` loads later, a type import is erased). The recording session and the flow page's state machine are
// the flow page's own: reaching them from here puts about 9 KB of the recorder in every list's first load
// (tests/prod/weight.spec.ts measures the whole).
const ENTRIES = ["app/flows/page.tsx", "app/layout.tsx"];
const FLOW_PAGE_ONLY = ["lib/flow-session.ts", "lib/recording-session.ts"];
// The list shows the recordings a device still holds, so it reads the store, and nothing else of the recorder.
const STORE_READERS = ["components/UnsentRecordings.tsx", "components/save-recording.ts"];

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? specifier.slice(2) : specifier.startsWith(".") ? normalize(join(dirname(from), specifier)) : null;
  if (!base) return null;
  return [".ts", ".tsx", "/index.ts", "/index.tsx"].map((suffix) => base + suffix).find(existsSync) ?? null;
}

/** The modules a file imports as values: `import type`, and an import whose names are all `type`, are erased. */
function staticImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const match of source.matchAll(/\b(?:import|export)\s+(type\s+)?([\w*${}\s,]+?)\s+from\s+["']([^"']+)["']/g)) {
    const [, typeOnly, bindings, specifier] = match;
    if (typeOnly) continue;
    const values = bindings.replace(/[{}]/g, ",").split(",").map((name) => name.trim()).filter((name) => name && !name.startsWith("type "));
    if (values.length === 0) continue;
    const target = resolveImport(file, specifier);
    if (target) found.push(target);
  }
  return found;
}

function closure(entries: string[]): Map<string, string | null> {
  const reached = new Map<string, string | null>();
  const queue = entries.map((entry): [string, string | null] => [entry, null]);
  while (queue.length > 0) {
    const [file, via] = queue.pop()!;
    if (reached.has(file)) continue;
    reached.set(file, via);
    for (const next of staticImports(file)) queue.push([next, file]);
  }
  return reached;
}

test("the flow list's first load does not reach the recorder or the flow page's session", () => {
  const reached = closure(ENTRIES);
  assert.ok(reached.has("app/flows/FlowsPage.tsx"), "the walk finds the list's own page");
  for (const module of FLOW_PAGE_ONLY) {
    const path: string[] = [];
    for (let file: string | null | undefined = module; file; file = reached.get(file)) path.push(file);
    assert.equal(reached.has(module), false, `${module} is in the list's first load, through ${path.slice(1).join(" <- ")}`);
  }
  const readers = [...reached.keys()].filter((file) => staticImports(file).includes("lib/recording-store.ts"));
  assert.deepEqual(readers.sort(), STORE_READERS.sort(), "only the unsent list reads the recording store");
});
