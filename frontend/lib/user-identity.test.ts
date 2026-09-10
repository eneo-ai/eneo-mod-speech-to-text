import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCESS_CODE_USER,
  sessionUser,
  userDisplayName,
  userInitial,
} from "./user-identity";

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

test("an authenticated access-code session gets a placeholder identity", () => {
  const user = sessionUser({
    authenticated: true,
    auth_mode: "access_code",
    user: null,
  });
  assert.equal(user, ACCESS_CODE_USER);
  assert.equal(userDisplayName(ACCESS_CODE_USER), "Testläge");
  assert.equal(userInitial(ACCESS_CODE_USER), "T");
});

test("an unauthenticated or user-less SSO session has no identity", () => {
  assert.equal(
    sessionUser({ authenticated: false, auth_mode: "access_code", user: null }),
    null,
  );
  assert.equal(
    sessionUser({ authenticated: true, auth_mode: "eneo_sso", user: null }),
    null,
  );
  const eneoUser = { id: "u1", email: "anna@example.test" };
  assert.equal(
    sessionUser({ authenticated: true, auth_mode: "eneo_sso", user: eneoUser }),
    eneoUser,
  );
});
