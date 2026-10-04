import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement, useState } from "react";
import { button, cleanup, installDom, mount, type } from "./test-dom";

installDom();
afterEach(cleanup);

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Names in a ParticipantsInput that keeps its own list, as the form does, and what it reported as added. */
async function mountNames(names: string[] = [], suggestions: string[] = []) {
  const { ParticipantsInput } = await import("../components/flow/ParticipantsInput");
  const { ModuleProviders } = await import("@/kit/ModuleProviders");
  const added: string[][] = [];
  function Field() {
    const [list, setList] = useState(names);
    return createElement(ParticipantsInput, { label: "Deltagare", fieldName: "namn", names: list, onChange: setList, suggestions, onAdded: (fresh: string[]) => added.push(fresh) });
  }
  // In the page's providers, so the design system's own words (the remove buttons') are Swedish as they are there.
  const view = await mount(createElement(ModuleProviders, { children: createElement(Field) }));
  const input = () => view.container.querySelector<HTMLInputElement>('[data-detail-field="namn"]')!;
  const shown = () => [...view.container.querySelectorAll("ul[aria-label='Tillagda namn'] li")].map((li) => li.textContent);
  return { view, input, shown, added };
}

test("participants: a comma adds what came before it, and Backspace in the empty field takes the last name back", async () => {
  const { view, input, shown } = await mountNames(["Anna Berg"]);
  await view.act(async () => type(input(), "Erik Lund, Sa"));
  assert.deepEqual(shown(), ["Anna Berg", "Erik Lund"]);
  assert.equal(input().value, "Sa", "what follows the comma stays to be finished");
  await view.act(async () => type(input(), ""));
  await view.act(async () => input().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true })));
  assert.deepEqual(shown(), ["Anna Berg"]);
});

test("participants: a name's remove button takes it away and the focus goes back to the field", async () => {
  const { view, input, shown } = await mountNames(["Anna Berg", "Erik Lund"]);
  await view.act(async () => button(view.container, "Ta bort Anna Berg")!.click());
  assert.deepEqual(shown(), ["Erik Lund"]);
  assert.equal(document.activeElement, input());
});

test("a date detail shows the date it holds once its calendar has loaded", async () => {
  const { DetailsForm } = await import("../components/flow/DetailsForm");
  const view = await mount(
    createElement(DetailsForm, { fields: [{ name: "datum", label: "Datum", type: "date" }], details: { datum: "2026-09-24" }, invalid: [], onChange: () => {}, suggestions: [], onNamesAdded: () => {} }),
  );
  await view.act(async () => settle(100));
  const date = view.container.querySelector<HTMLElement>('[data-detail-field="datum"]');
  assert.ok(date, "the date field is there");
  assert.match(date.textContent + (date.querySelector("input")?.value ?? "") + ((date as HTMLInputElement).value ?? ""), /2026|24/, "and shows the date it holds");
});

test("the design system's busy button stays enabled when it may be interrupted, which the start relies on to keep focus", async () => {
  const { Button } = await import("@astryxdesign/core/Button");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(createElement(Button, { label: "Startar…", isLoading: true, isInterruptible: true }));
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /\sdisabled=/, "a disabled button drops the focus the person is on");
  const plain = renderToStaticMarkup(createElement(Button, { label: "Startar…", isLoading: true }));
  assert.match(plain, /\sdisabled=""/, "without it, busy means disabled");
});
