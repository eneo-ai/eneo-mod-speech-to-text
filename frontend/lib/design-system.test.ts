import assert from "node:assert/strict";
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
  const { ThemeProvider } = await import("next-themes");
  const { AppShell } = await import("@astryxdesign/core/AppShell");
  const view = await mount(
    createElement(ThemeProvider, { attribute: "class", children: createElement(ModuleProviders, { children: createElement(AppShell, { height: "auto", mobileNav: false, children: "Sidan" }) }) }),
  );
  assert.ok(view.container.querySelector('[data-astryx-theme="eneo"]'), "themed");
  assert.match(view.container.textContent ?? "", /Hoppa till innehåll/);
});

test("the shell gives a page its skip link, its navigation landmark and one main region", async () => {
  const { ModuleShell } = await import("@/kit/ModuleShell");
  const { ModuleProviders } = await import("@/kit/ModuleProviders");
  const { ThemeProvider } = await import("next-themes");
  const view = await mount(
    createElement(ThemeProvider, {
      attribute: "class",
      children: createElement(ModuleProviders, {
        children: createElement(ModuleShell, { label: "Tal till text", heading: "Tal till text", end: "Konto", children: "Sidan" }),
      }),
    }),
  );
  assert.equal(view.container.querySelectorAll('[role="main"], main').length, 1, "one main region");
  assert.ok(view.container.querySelector('nav[aria-label="Tal till text"]'), "a named navigation landmark");
  assert.match(view.container.textContent ?? "", /Hoppa till innehåll/);
});
