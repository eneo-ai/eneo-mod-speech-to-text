import assert from "node:assert/strict";
import test from "node:test";

import { userDisplayName, userInitial } from "./user-identity";

test("uses the trimmed Eneo username as display name and avatar initial", () => {
  const user = {
    id: "user-id",
    email: "asa@example.test",
    username: "  Åsa Öberg  ",
  };

  assert.equal(userDisplayName(user), "Åsa Öberg");
  assert.equal(userInitial(user), "Å");
});

test("falls back to the email address when Eneo has no username", () => {
  const user = {
    id: "user-id",
    email: "anna@example.test",
    username: "   ",
  };

  assert.equal(userDisplayName(user), "anna@example.test");
  assert.equal(userInitial(user), "A");
});

test("uses a safe fallback for an invalid empty identity", () => {
  const user = { id: "user-id", email: "" };

  assert.equal(userDisplayName(user), "");
  assert.equal(userInitial(user), "?");
});
