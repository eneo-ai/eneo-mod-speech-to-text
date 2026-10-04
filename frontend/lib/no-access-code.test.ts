import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The access code is gone, and stays gone: Eneo's login is the only way in, so nothing of the page names a mode, a code or
// a code form, and nothing asks the module for a flow-list scope that only the code needed (/api/config, a space).
const GONE = /access_code|accessCode|AccessCode|ACCESS_CODE|auth_mode|AuthMode|åtkomstkod|\/api\/config|AppConfig|getConfig|FLOW_LIST_NOT_CONFIGURED/i;

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });

test("no module of the page knows an access code, an auth mode or the demo space's config", () => {
  const files = ["components", "kit", "lib", "routes"].flatMap(sources);
  assert.deepEqual(files.filter((file) => GONE.test(readFileSync(file, "utf8"))), []);
});
