import assert from "node:assert/strict";
import test from "node:test";

import { getConfig } from "./api";
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

  assert.deepEqual(heard, [false, true, false, true, false, true], "each change is heard once");
  assert.equal(createOnlineStatus(fakeBrowser(false).target).online, false, "a page opened offline starts offline");
});

test("requests report whether the module can be reached", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(getConfig());
  assert.equal(onlineStatus.online, false);

  t.mock.method(globalThis, "fetch", async () => new Response("upstream down", { status: 502 }));
  await assert.rejects(getConfig());
  assert.equal(onlineStatus.online, true, "an error response still means the module answered");
});
