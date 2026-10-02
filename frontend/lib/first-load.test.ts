import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

// What a page loads for every visit: the modules its route and the frame around every route import, followed
// statically (an `import()` loads later, which is how routes.tsx hands out the pages, and a type import is erased).
// The recording session and the flow page's state machine are the flow page's own: reaching them from the list puts
// about 9 KB of the recorder in every list's first load (tests/prod/weight.spec.ts measures the whole).
const FRAME = ["main.tsx", "routes.tsx", "routes/Root.tsx"];
const ENTRIES = ["routes/FlowsPage.tsx", ...FRAME];
const FLOW_PAGE_ONLY = ["lib/flow-session.ts", "lib/recording-session.ts"];
// What only the flow page shows: the recording, its playback and the review. The sign-in page loads none of it.
const RECORDING_AND_REVIEW = [
  ...FLOW_PAGE_ONLY,
  "lib/recording-store.ts",
  "components/flow/FlowInput.tsx",
  "components/flow/ReviewView.tsx",
  "components/TranscriptEditor.tsx",
  "components/TranscriptPlayer.tsx",
];
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
  assert.ok(reached.has("routes/FlowsPage.tsx"), "the walk finds the list's own page");
  for (const module of FLOW_PAGE_ONLY) {
    const path: string[] = [];
    for (let file: string | null | undefined = module; file; file = reached.get(file)) path.push(file);
    assert.equal(reached.has(module), false, `${module} is in the list's first load, through ${path.slice(1).join(" <- ")}`);
  }
  const readers = [...reached.keys()].filter((file) => staticImports(file).includes("lib/recording-store.ts"));
  assert.deepEqual(readers.sort(), STORE_READERS.sort(), "only the unsent list reads the recording store");
});

test("the sign-in page's first load does not reach the recorder, the playback or the review", () => {
  const reached = closure(["routes/LoginPage.tsx", ...FRAME]);
  assert.ok(reached.has("routes/LoginPage.tsx"), "the walk finds the sign-in page");
  assert.ok(reached.has("routes/Root.tsx"), "and the frame");
  for (const module of RECORDING_AND_REVIEW) {
    const path: string[] = [];
    for (let file: string | null | undefined = module; file; file = reached.get(file)) path.push(file);
    assert.equal(reached.has(module), false, `${module} is in the sign-in page's first load, through ${path.slice(1).join(" <- ")}`);
  }
});

test("routes.tsx hands every page out by import(), so no page is in the frame's first load", () => {
  const frame = closure(FRAME);
  for (const page of ["routes/LoginPage.tsx", "routes/FlowsPage.tsx", "routes/FlowPage.tsx", "routes/SignedInAgain.tsx"]) {
    assert.equal(frame.has(page), false, `${page} is loaded statically by the frame`);
  }
});
