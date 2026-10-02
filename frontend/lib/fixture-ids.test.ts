import assert from "node:assert/strict";
import { test } from "node:test";
import ids from "../tests/fixtures/ids.json";

// The stub backend (tests/e2e/stub-server.py) and the gate read these identifiers from one file. The backend's live route
// takes UUIDs for the flow and the step (backend/app/main.py), so a fixture that is not one cannot go through it.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const all = Object.entries(ids).flatMap(([kind, group]) => Object.entries(group).map(([name, id]) => ({ name: `${kind}.${name}`, id })));

test("every fixture identifier is a canonical UUID", () => {
  assert.deepEqual(
    all.filter(({ id }) => !UUID.test(id)).map(({ name }) => name),
    [],
  );
});

test("no two fixtures share an identifier", () => {
  const seen = new Map<string, string>();
  for (const { name, id } of all) {
    assert.equal(seen.get(id), undefined, `${name} repeats ${seen.get(id)}`);
    seen.set(id, name);
  }
});
