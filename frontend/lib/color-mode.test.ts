import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { createElement } from "react";

import { cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(async () => {
  await cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

/** The operating system's choice, as a test controls it: `matches` now, and `change` events to whoever listens. */
function operatingSystem(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return dark;
    },
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  const matchMedia = (media: string) => (media.includes("prefers-color-scheme") ? query : { matches: false, media, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(window, "matchMedia", { value: matchMedia, configurable: true, writable: true });
  Object.defineProperty(globalThis, "matchMedia", { value: matchMedia, configurable: true, writable: true });
  return {
    choose(next: boolean) {
      dark = next;
      listeners.forEach((listener) => listener());
    },
    listening: () => listeners.size,
  };
}

const load = () => import("@/kit/ColorModeProvider");

test("a stored light, dark or system is read as it is, and anything else is system", async () => {
  const { readStoredColorMode } = await load();
  const storage = (value: string | null) => ({ getItem: () => value }) as unknown as Storage;
  for (const mode of ["light", "dark", "system"] as const) assert.equal(readStoredColorMode(storage(mode)), mode);
  for (const value of [null, "", "Dark", "auto", "dark "]) assert.equal(readStoredColorMode(storage(value)), "system", String(value));
  const blocked = {
    getItem() {
      throw new Error("blocked");
    },
  } as unknown as Storage;
  assert.equal(readStoredColorMode(blocked), "system", "storage that throws (a private window, blocked site data) is no choice");
});

test("the stored mode is the one on the first render, so no frame is drawn in the other", async () => {
  const { ColorModeProvider, useColorMode } = await load();
  operatingSystem(false);
  localStorage.setItem("theme", "dark");
  const seen: string[] = [];
  function Probe() {
    seen.push(useColorMode().mode);
    return null;
  }
  await mount(createElement(ColorModeProvider, { children: createElement(Probe) }));
  assert.ok(seen.length > 0);
  assert.deepEqual([...new Set(seen)], ["dark"], "every render, the first included, had the stored mode");
});

test("with nothing stored the mode is system, which follows the operating system, and its changes", async () => {
  const { ColorModeProvider, useColorMode } = await load();
  const system = operatingSystem(true);
  let current: ReturnType<typeof useColorMode> | undefined;
  function Probe() {
    current = useColorMode();
    return null;
  }
  const view = await mount(createElement(ColorModeProvider, { children: createElement(Probe) }));
  assert.equal(current?.mode, "system");
  assert.equal(current?.resolved, "dark");
  await view.act(async () => system.choose(false));
  assert.equal(current?.resolved, "light", "the system's change reaches the page");
  await view.unmount();
  assert.equal(system.listening(), 0, "and the listener goes with the provider");
});

test("a chosen mode ignores the operating system, and is written back for the next visit", async () => {
  const { ColorModeProvider, useColorMode } = await load();
  operatingSystem(true);
  let current: ReturnType<typeof useColorMode> | undefined;
  function Probe() {
    current = useColorMode();
    return null;
  }
  const view = await mount(createElement(ColorModeProvider, { children: createElement(Probe) }));
  await view.act(async () => current?.setMode("light"));
  assert.deepEqual([current?.mode, current?.resolved], ["light", "light"]);
  assert.equal(localStorage.getItem("theme"), "light");
  await view.act(async () => current?.setMode("system"));
  assert.deepEqual([current?.mode, current?.resolved, localStorage.getItem("theme")], ["system", "dark", "system"]);
});

test("a choice that cannot be stored still applies for the visit", async () => {
  const { ColorModeProvider, useColorMode } = await load();
  operatingSystem(false);
  const setItem = window.Storage.prototype.setItem;
  window.Storage.prototype.setItem = () => {
    throw new Error("quota");
  };
  try {
    let current: ReturnType<typeof useColorMode> | undefined;
    function Probe() {
      current = useColorMode();
      return null;
    }
    const view = await mount(createElement(ColorModeProvider, { children: createElement(Probe) }));
    await view.act(async () => current?.setMode("dark"));
    assert.equal(current?.mode, "dark");
  } finally {
    window.Storage.prototype.setItem = setItem;
  }
});

test("another tab's choice reaches this one", async () => {
  const { ColorModeProvider, useColorMode } = await load();
  operatingSystem(false);
  let current: ReturnType<typeof useColorMode> | undefined;
  function Probe() {
    current = useColorMode();
    return null;
  }
  const view = await mount(createElement(ColorModeProvider, { children: createElement(Probe) }));
  assert.equal(current?.mode, "system");
  localStorage.setItem("theme", "dark");
  await view.act(async () => void window.dispatchEvent(new window.StorageEvent("storage", { key: "theme", newValue: "dark" })));
  assert.equal(current?.mode, "dark");
  await view.act(async () => void window.dispatchEvent(new window.StorageEvent("storage", { key: "other", newValue: "light" })));
  assert.equal(current?.mode, "dark", "another key is none of its business");
});

test("the hook says so when there is no provider above it", async () => {
  const { useColorMode } = await load();
  function Probe() {
    useColorMode();
    return null;
  }
  await assert.rejects(() => mount(createElement(Probe)), /ColorModeProvider/);
});

test("the document is told the stored mode from the first render: data-theme for light and dark, none for the system's", async () => {
  const { ModuleProviders } = await import("@/kit/ModuleProviders");
  const { useColorMode } = await load();
  operatingSystem(true);
  const dataTheme = () => document.documentElement.getAttribute("data-theme");
  localStorage.setItem("theme", "light");
  let current: ReturnType<typeof useColorMode> | undefined;
  function Probe() {
    current = useColorMode();
    return null;
  }
  const first = await mount(createElement(ModuleProviders, { children: createElement(Probe) }));
  assert.equal(dataTheme(), "light", "light is told although the system is dark");
  await first.act(async () => current?.setMode("dark"));
  assert.equal(dataTheme(), "dark");
  await first.act(async () => current?.setMode("system"));
  assert.equal(dataTheme(), null, "the system's choice leaves the browser's own preference to paint it");
  await first.unmount();

  localStorage.setItem("theme", "dark");
  await mount(createElement(ModuleProviders, { children: createElement(Probe) }));
  assert.equal(dataTheme(), "dark", "a stored dark is there at once");
});

// The first paint is a script of its own (public/color-mode.js): CSS cannot read localStorage, and a correct first
// render of the page is not a correct first paint. It runs before any frame, as a file, not inline.
const SCRIPT = readFileSync(join(__dirname, "..", "..", "public", "color-mode.js"), "utf8");

/** Runs the first-paint script against a fake document and storage; returns what it set on <html>. */
function runFirstPaint(stored: string | null | "throws", access: "ok" | "blocked" = "ok") {
  const set: Record<string, string> = {};
  const document = { documentElement: { setAttribute: (name: string, value: string) => (set[name] = value) } };
  const storage = {
    getItem(key: string) {
      if (stored === "throws") throw new Error("blocked");
      return key === "theme" ? stored : null;
    },
  };
  const scope = access === "blocked" ? { document, get localStorage() { throw new Error("blocked site data"); } } : { document, localStorage: storage };
  new Function("scope", `with (scope) { ${SCRIPT} }`)(scope);
  return set;
}

test("the first-paint script sets data-theme for a stored light or dark, and nothing else", () => {
  assert.deepEqual(runFirstPaint("dark"), { "data-theme": "dark" });
  assert.deepEqual(runFirstPaint("light"), { "data-theme": "light" });
  for (const value of ["system", null, "", "Dark", "auto", "dark "]) assert.deepEqual(runFirstPaint(value), {}, String(value));
});

test("the first-paint script survives storage that throws, also when reading the property throws", () => {
  assert.deepEqual(runFirstPaint("throws"), {});
  assert.deepEqual(runFirstPaint(null, "blocked"), {});
});

test("the page loads it first, as a same-origin file that blocks the parser, and has no inline script or style", () => {
  const page = readFileSync(join(__dirname, "..", "..", "index.html"), "utf8");
  const head = page.slice(page.indexOf("<head>"), page.indexOf("</head>"));
  assert.match(head, /<script src="\/color-mode\.js"><\/script>/, "a classic script, no async, defer or module");
  assert.ok(head.indexOf('src="/color-mode.js"') < head.indexOf("<link"), "before the first stylesheet, so no frame is painted without it");
  assert.deepEqual([...page.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/g)], [], "no inline script");
  assert.deepEqual([...page.matchAll(/<style\b|\sstyle=/g)], [], "no inline style");
});

test("no style or component reads the old colour mode, a class on <html>", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const root = join(__dirname, "..", "..");
  const sources = (dir: string): string[] =>
    readdirSync(join(root, dir)).flatMap((name) => {
      const path = join(dir, name);
      if (path === join("kit", "theme", "built")) return []; // generated; it carries no mode selector, which this test would also find
      if (statSync(join(root, path)).isDirectory()) return sources(path);
      return /\.(css|tsx?)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
    });
  // `.dark` and `html.light` as selectors, and Tailwind's `dark:` variant: the mode is data-theme now.
  const OLD = /\.dark\b|html\.light|:root\.dark|\[class~=['"]?dark|\bdark:[a-z-]/;
  const found = ["styles", "components", "kit", "routes"].flatMap(sources).filter((file) => OLD.test(readFileSync(join(root, file), "utf8")));
  assert.deepEqual(found, []);
});

// A switch of the mode must not animate: the surfaces and the text change at once, so controls that fade over 175 ms
// (the design system's transitions) would lag behind them. For the frames that apply the new mode, `<html>` carries
// `data-theme-switching`, which one static rule in styles/globals.css answers with `transition: none`.
const switching = () => document.documentElement.hasAttribute("data-theme-switching");
const frames = (count: number) => new Promise<void>((resolve) => (function next(left: number) { left === 0 ? resolve() : requestAnimationFrame(() => next(left - 1)); })(count));

test("a chosen mode marks the document as switching for the frames that apply it, and no longer", async () => {
  const { ColorModeProvider, useColorMode } = await load();
  operatingSystem(false);
  let current: ReturnType<typeof useColorMode> | undefined;
  function Probe() {
    current = useColorMode();
    return null;
  }
  const view = await mount(createElement(ColorModeProvider, { children: createElement(Probe) }));
  assert.equal(switching(), false, "not on the first render");
  await view.act(async () => current?.setMode("dark"));
  assert.equal(switching(), true, "from the choice, before the page shows the new mode");
  await view.act(async () => frames(4));
  assert.equal(switching(), false, "and over a frame or two later");
});

test("the operating system's change and another tab's choice mark it too, from the event, before React has rendered", async () => {
  const { ColorModeProvider, useColorMode } = await load();
  const system = operatingSystem(false);
  let current: ReturnType<typeof useColorMode> | undefined;
  function Probe() {
    current = useColorMode();
    return null;
  }
  const view = await mount(createElement(ColorModeProvider, { children: createElement(Probe) }));
  system.choose(true); // outside act: the event itself, no render yet
  assert.equal(switching(), true, "the system's change");
  await view.act(async () => frames(4));
  assert.equal(switching(), false);
  localStorage.setItem("theme", "dark");
  window.dispatchEvent(new window.StorageEvent("storage", { key: "theme", newValue: "dark" }));
  assert.equal(switching(), true, "another tab's choice");
  await view.act(async () => frames(4));
  assert.equal(current?.mode, "dark");
  assert.equal(switching(), false);
});

test("an event that changes nothing marks nothing: the same mode again, the same system answer, another key", async () => {
  const { ColorModeProvider, useColorMode } = await load();
  const system = operatingSystem(true);
  localStorage.setItem("theme", "dark");
  let current: ReturnType<typeof useColorMode> | undefined;
  function Probe() {
    current = useColorMode();
    return null;
  }
  const view = await mount(createElement(ColorModeProvider, { children: createElement(Probe) }));
  await view.act(async () => current?.setMode("dark"));
  assert.equal(switching(), false, "dark chosen while dark");
  system.choose(true);
  assert.equal(switching(), false, "the system says what it said");
  window.dispatchEvent(new window.StorageEvent("storage", { key: "other", newValue: "x" }));
  assert.equal(switching(), false, "another key");
});

test("one static rule turns every transition off while the document is switching", () => {
  const css = readFileSync(join(__dirname, "..", "..", "styles", "globals.css"), "utf8");
  assert.match(css, /\[data-theme-switching\] \*[^{]*\{[^}]*transition:\s*none\s*!important/);
});
