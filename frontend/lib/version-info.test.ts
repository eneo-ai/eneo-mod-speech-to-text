import assert from "node:assert/strict";
import test, { afterEach, type TestContext } from "node:test";
import { createElement } from "react";

import { cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(cleanup);

const REVISION = "c5d54608d5833737677157bde44b95b969e67bbb";
// The reader's own time, whatever the test machine's is: "8 okt 2026 10:04".
const BUILT = new Date(2026, 9, 8, 10, 4, 12).toISOString();
const RELEASE = { ok: true, release: "v0.1.0", revision: REVISION, build_date: BUILT };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The browser's fetch, answering with what `answer` gives and keeping what was asked. */
function useFetch(t: TestContext, answer: () => Promise<Response>) {
  const requests: string[] = [];
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);
    return answer();
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = browserFetch;
  });
  return requests;
}

async function versionInfo() {
  const { VersionInfo } = await import("../components/VersionInfo");
  const view = await mount(createElement(VersionInfo));
  const trigger = () => [...view.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Version")!;
  const press = (element: HTMLElement) =>
    view.act(async () => {
      element.click();
      await settle();
    });
  /** Each term of the list and what it says. */
  const rows = () => [...view.container.querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]);
  const button = (name: string) => [...view.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  return { ...view, trigger, press, rows, button };
}

test("Version is folded away and reads the build when it is first opened, not with the page", async (t) => {
  let answer!: (response: Response) => void;
  const requests = useFetch(t, () => new Promise((resolve) => (answer = resolve)));
  const { trigger, press, rows, act, container } = await versionInfo();
  await act(settle);
  assert.equal(trigger().getAttribute("aria-expanded"), "false");
  assert.deepEqual(requests, [], "nothing is read with the page");

  await press(trigger());
  assert.equal(trigger().getAttribute("aria-expanded"), "true");
  assert.deepEqual(requests, ["GET /api/healthz"]);
  assert.match(container.textContent ?? "", /Hämtar versionen…/, "says it is on its way");

  await act(async () => {
    answer(json(RELEASE));
    await settle();
  });
  assert.deepEqual(rows(), [["Utgåva", "v0.1.0"], ["Commit", "c5d5460"], ["Byggd", "8 okt 2026 10:04"]]);

  await press(trigger());
  await press(trigger());
  assert.deepEqual(requests, ["GET /api/healthz"], "closed and opened again, it shows what it read");
  assert.deepEqual(rows()[0], ["Utgåva", "v0.1.0"]);
});

test("the commit opens its page on GitHub in a new tab, and Kopiera supportinformation copies the build as plain text", async (t) => {
  useFetch(t, async () => json(RELEASE));
  const written: string[] = [];
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => void written.push(text) }, configurable: true });
  t.after(() => (original ? Object.defineProperty(navigator, "clipboard", original) : Reflect.deleteProperty(navigator, "clipboard")));
  const { trigger, press, button, container } = await versionInfo();
  await press(trigger());

  const link = container.querySelector<HTMLAnchorElement>("a[href]")!;
  assert.equal(link.getAttribute("href"), `https://github.com/eneo-ai/eneo-mod-speech-to-text/commit/${REVISION}`);
  assert.equal(link.getAttribute("target"), "_blank");
  assert.match(link.getAttribute("rel") ?? "", /noopener/);
  assert.equal(link.textContent?.trim(), "Visa commiten på GitHub");
  assert.equal(link.getAttribute("aria-label"), "Visa commiten på GitHub i en ny flik", "its name starts with the words it shows");

  await press(button("Kopiera supportinformation")!);
  await new Promise(requestAnimationFrame);
  assert.deepEqual(written, [["Tal till text", "Utgåva: v0.1.0", `Commit: ${REVISION}`, `Byggd: ${BUILT}`, "Adress: http://localhost"].join("\n")]);
  assert.ok(button("Kopierat"), "and says so");
});

test("a build with nothing known is a development version, says Okänd, and links to no commit", async (t) => {
  useFetch(t, async () => json({ ok: true, release: null, revision: null, build_date: null }));
  const { trigger, press, rows, button, container } = await versionInfo();
  await press(trigger());
  assert.deepEqual(rows(), [["Utgåva", "Utvecklingsversion"], ["Commit", "Okänd"], ["Byggd", "Okänd"]]);
  assert.equal(container.querySelector("a[href]"), null);
  assert.ok(button("Kopiera supportinformation"));
});

test("a read that fails says so, and Försök igen reads again", async (t) => {
  let answer = async () => json({ detail: "unavailable" }, 503);
  const requests = useFetch(t, () => answer());
  const { trigger, press, rows, button, container } = await versionInfo();
  await press(trigger());
  assert.match(container.textContent ?? "", /Versionen kunde inte visas\./);
  assert.deepEqual(rows(), []);

  answer = async () => json(RELEASE);
  await press(button("Försök igen")!);
  assert.deepEqual(requests, ["GET /api/healthz", "GET /api/healthz"]);
  assert.deepEqual(rows()[0], ["Utgåva", "v0.1.0"]);
});
