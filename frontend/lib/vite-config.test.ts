import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Vite is moving to loading its config the way Node loads a module (`configLoader: 'native'`): every import with its
// extension, and what it imports as ESM. Today it bundles the config and only warns, at every start of the dev server and
// every build.
test("the build's config loads as Node itself loads it, with no import left without its extension", { skip: !process.features.typescript }, () => {
  const loaded = spawnSync(process.execPath, ["--input-type=module", "-e", "const { default: config } = await import('./vite.config.mts'); console.log(typeof config);"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(loaded.stdout.trim(), "function");
  assert.doesNotMatch(loaded.stderr, /Warning/, "nothing for Node to warn about, such as a module whose type it had to guess");
});
