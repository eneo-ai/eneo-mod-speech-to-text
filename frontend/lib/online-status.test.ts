import assert from "node:assert/strict";
import test from "node:test";

import { authStatus } from "./api";
import { createOnlineStatus, onlineStatus, type OnlineTarget } from "./online-status";

/** A browser window whose connection the test switches. */
function fakeBrowser(onLine: boolean) {
  const target = Object.assign(new EventTarget(), { navigator: { onLine } });
  return {
    target: target as OnlineTarget,
    go(online: boolean) {
      target.navigator.onLine = online;
      target.dispatchEvent(new Event(online ? "online" : "offline"));
    },
  };
}

test("the browser's online events and our own requests decide whether we are online", () => {
  const browser = fakeBrowser(true);
  const status = createOnlineStatus(browser.target);
  const heard: boolean[] = [];
  status.subscribe((online) => heard.push(online));
  assert.equal(status.online, true);

  browser.go(false);
  assert.equal(status.online, false);
  browser.go(true);
  assert.equal(status.online, true);

  // Connected to a network that does not reach the module.
  status.reportNetworkFailure();
  assert.equal(status.online, false);
  status.reportNetworkFailure();
  status.reportReachable();
  assert.equal(status.online, true);

  status.reportNetworkFailure();
  browser.go(false);
  browser.go(true);
  assert.equal(status.online, true, "the connection coming back clears an earlier failure");

  // The last change of cause, from a module that does not answer to a device with no network, is heard too.
  assert.deepEqual(heard, [false, true, false, true, false, false, true], "each change is heard once");
  assert.equal(createOnlineStatus(fakeBrowser(false).target).online, false, "a page opened offline starts offline");
});

test("a device with no network and a module that does not answer are told apart", () => {
  const browser = fakeBrowser(true);
  const status = createOnlineStatus(browser.target);
  assert.equal(status.connection, "online");

  browser.go(false);
  assert.equal(status.connection, "offline", "the browser says there is no network");
  browser.go(true);
  assert.equal(status.connection, "online");

  status.reportNetworkFailure();
  assert.equal(status.connection, "unreachable", "the browser has a network, and the request did not reach the module");
  status.reportReachable();
  assert.equal(status.connection, "online");

  // A failure while the device has no network is the device's loss, not the module's.
  browser.go(false);
  status.reportNetworkFailure();
  assert.equal(status.connection, "offline");
  browser.go(true);
  assert.equal(status.connection, "online", "the network coming back clears it");
  assert.equal(createOnlineStatus(fakeBrowser(false).target).connection, "offline");
});

test("requests report whether the module can be reached", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(authStatus());
  assert.equal(onlineStatus.online, false);

  t.mock.method(globalThis, "fetch", async () => new Response("upstream down", { status: 502 }));
  await assert.rejects(authStatus());
  assert.equal(onlineStatus.online, true, "an error response still means the module answered");
});
