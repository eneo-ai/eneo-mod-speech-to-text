import assert from "node:assert/strict";
import test from "node:test";

import { sessionUser, userDisplayName } from "./user-identity";

test("uses the trimmed Eneo username as display name", () => {
  const user = {
    id: "user-id",
    email: "asa@example.test",
    username: "  Åsa Öberg  ",
  };

  assert.equal(userDisplayName(user), "Åsa Öberg");
});

test("falls back to the email address when Eneo has no username", () => {
  const user = {
    id: "user-id",
    email: "anna@example.test",
    username: "   ",
  };

  assert.equal(userDisplayName(user), "anna@example.test");
});

test("uses a safe fallback for an invalid empty identity", () => {
  const user = { id: "user-id", email: "" };

  assert.equal(userDisplayName(user), "");
});

test("an unauthenticated session, or one that names nobody, has no identity", () => {
  assert.equal(sessionUser({ authenticated: false, user: null }), null);
  assert.equal(
    sessionUser({ authenticated: true, user: null }),
    null,
  );
  const eneoUser = { id: "u1", email: "anna@example.test" };
  assert.equal(
    sessionUser({ authenticated: true, user: eneoUser }),
    eneoUser,
  );
});
