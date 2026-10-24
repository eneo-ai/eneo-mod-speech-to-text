import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import { cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(cleanup);

test("a design-system dialog opens where it is rendered, named, under the test document", async () => {
  const { Dialog } = await import("@astryxdesign/core/Dialog");
  const view = await mount(
    createElement(Dialog, {
      isOpen: true,
      onOpenChange() {},
      purpose: "required",
      role: "alertdialog",
      "aria-label": "Du behöver logga in igen",
      children: createElement("p", null, "Logga in igen."),
    }),
  );
  const dialog = view.container.querySelector("dialog");
  assert.ok(dialog?.hasAttribute("open"), "open");
  assert.equal(dialog?.getAttribute("role"), "alertdialog");
});

test("the providers render a page in the Swedish catalog and the Eneo theme", async () => {
  const { ModuleProviders } = await import("@/kit/ModuleProviders");
  const { AppShell } = await import("@astryxdesign/core/AppShell");
  const view = await mount(createElement(ModuleProviders, { children: createElement(AppShell, { height: "auto", mobileNav: false, children: "Sidan" }) }));
  assert.ok(view.container.querySelector('[data-astryx-theme="eneo"]'), "themed");
  assert.match(view.container.textContent ?? "", /Hoppa till innehåll/);
});

test("the shell gives a page its skip link, its navigation landmark and one main region", async () => {
  const { ModuleShell } = await import("@/kit/ModuleShell");
  const { ModuleProviders } = await import("@/kit/ModuleProviders");
  const view = await mount(
    createElement(ModuleProviders, {
      children: createElement(ModuleShell, { label: "Tal till text", heading: "Tal till text", end: "Konto", children: "Sidan" }),
    }),
  );
  assert.equal(view.container.querySelectorAll('[role="main"], main').length, 1, "one main region");
  assert.ok(view.container.querySelector('nav[aria-label="Tal till text"]'), "a named navigation landmark");
  assert.match(view.container.textContent ?? "", /Hoppa till innehåll/);
});

test("a heading that wraps balances its lines, so a phone does not leave one word alone on the last", () => {
  const heading = /\.astryx-heading \{([^}]*)\}/.exec(readFileSync("kit/theme/built/eneo.css", "utf8"))?.[1] ?? "";
  assert.match(heading, /text-wrap:\s*balance;/);
  assert.match(heading, /overflow-wrap:\s*anywhere;/, "a word with no break point still wraps");
});

test("nothing of Next.js is left: no package, no script, no file", () => {
  const { dependencies = {}, devDependencies = {}, scripts = {} } = JSON.parse(readFileSync("package.json", "utf8"));
  const installed = Object.keys({ ...dependencies, ...devDependencies });
  assert.deepEqual(installed.filter((name) => name === "next" || name === "next-themes" || name.startsWith("@next/")), []);
  assert.deepEqual(Object.entries(scripts).filter(([, command]) => /\bnext\b\s+(dev|build|start)/.test(String(command))), []);
  for (const file of ["next.config.mjs", "next-env.d.ts", "lib/backend-base.mjs", "tests/prod/serve.mjs", "components/theme-provider.tsx"]) {
    assert.equal(existsSync(file), false, `${file} belonged to Next`);
  }
});

test("an icon given to a button is the design system's Icon, sized as the rest, never a bare 24 px drawing", () => {
  // A drawing passed as is keeps its own 24 px: the button's icon slot grows with what it holds (styles/globals.css).
  // Also a drawing chosen by a condition: icon={playing ? <Pause aria-hidden /> : <Headphones aria-hidden />}.
  const bare = /icon=\{[^{}]*?<(?!Icon\b)[A-Z]\w* aria-hidden(?: className=\{[^}]*\})? \/>/g;
  const found = readdirSync("components", { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".tsx"))
    .flatMap((file) => [...readFileSync(`components/${file}`, "utf8").matchAll(bare)].map((match) => `${file}: ${match[0]}`));
  assert.deepEqual(found, []);
});
