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

test("an answer from the module outweighs a browser that says there is no network", () => {
  // Safari can go on saying offline after a device wakes, while every request reaches the module.
  const browser = fakeBrowser(false);
  const status = createOnlineStatus(browser.target);
  const heard: boolean[] = [];
  status.subscribe((online) => heard.push(online));
  assert.equal(status.connection, "offline", "a page opened offline starts offline");

  status.reportReachable(status.sending());
  assert.equal(status.connection, "online", "the module answered, so the device has a network");
  assert.deepEqual(heard, [true], "and what waits for the connection hears it");

  browser.go(false);
  assert.equal(status.connection, "offline", "a network lost after that is still the browser's to say");
});

test("an answer to a request that left before the network went does not bring it back", () => {
  let now = 0;
  const browser = fakeBrowser(true);
  const status = createOnlineStatus(browser.target, () => now);
  now = 100;
  const early = status.sending();
  now = 200;
  browser.go(false);
  now = 300;
  status.reportReachable(early);
  assert.equal(status.connection, "offline", "the answer was already on its way: it says nothing of the network now");

  // The page's own failure meanwhile is the device's loss, and an early answer clears nothing but that.
  status.reportNetworkFailure();
  status.reportReachable(early);
  assert.equal(status.connection, "offline");

  now = 400;
  status.reportReachable(status.sending());
  assert.equal(status.connection, "online", "a request that left after the browser said so, and was answered, says the browser is wrong");
});

test("a module that did not answer is asked again by itself, less and less often, until it answers", async (t) => {
  // After one failed request the page says Tal till text does not answer; nothing else may come by to clear that.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  const asked: number[] = [];
  let answers = false;
  let clock = 0;
  const status = createOnlineStatus(fakeBrowser(true).target, () => clock, async () => {
    asked.push(clock);
    return answers;
  });
  const tick = async (ms: number) => {
    clock += ms;
    t.mock.timers.tick(ms);
    await flush();
  };
  const heard: boolean[] = [];
  status.subscribe((online) => heard.push(online));

  status.reportNetworkFailure();
  await tick(4_999);
  assert.deepEqual(asked, [], "not at once: the failure is fresh");
  await tick(1);
  assert.deepEqual(asked, [5_000], "asked after 5 s");
  await tick(10_000);
  assert.deepEqual(asked, [5_000, 15_000], "then after twice as long");
  answers = true;
  await tick(20_000);
  assert.equal(status.connection, "online", "it answered: the page is told");
  assert.deepEqual(heard, [false, true]);
  await tick(120_000);
  assert.equal(asked.length, 3, "and nothing is asked once it answers");
});

test("a device with no network is not asked about: the browser says when it is back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const browser = fakeBrowser(true);
  let asked = 0;
  const status = createOnlineStatus(browser.target, undefined, async () => {
    asked += 1;
    return true;
  });
  browser.go(false);
  status.reportNetworkFailure();
  t.mock.timers.tick(120_000);
  await Promise.resolve();
  assert.equal(asked, 0);
  assert.equal(status.connection, "offline");
});
