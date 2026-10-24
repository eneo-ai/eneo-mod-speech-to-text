import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement, useState } from "react";
import { button, cleanup, installDom, mount, type, visualViewport } from "./test-dom";

installDom();
afterEach(cleanup);

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Names in a ParticipantsInput that keeps its own list, as the form does, and what it reported as added. */
async function mountNames(names: string[] = [], suggestions: string[] = [], description?: string) {
  const { ParticipantsInput } = await import("../components/flow/ParticipantsInput");
  const { ModuleProviders } = await import("@/kit/ModuleProviders");
  const added: string[][] = [];
  function Field() {
    const [list, setList] = useState(names);
    return createElement(ParticipantsInput, { label: "Deltagare", fieldName: "namn", names: list, onChange: setList, suggestions, description, onAdded: (fresh: string[]) => added.push(fresh) });
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

test("participants: each name added starts with a capital, as the first one typed does: iOS leaves its shift off in the field the page emptied", async () => {
  const { view, input, shown, added } = await mountNames(["Kale Lindkvist"]);
  const enter = () => input().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await view.act(async () => type(input(), "elik"));
  await view.act(async () => enter());
  await view.act(async () => type(input(), "åsa Holm, Erik lund,"));
  assert.deepEqual(shown(), ["Kale Lindkvist", "Elik", "Åsa Holm", "Erik lund"], "only the first letter: iOS capitalises each later word itself");
  assert.deepEqual(added, [["Elik"], ["Åsa Holm", "Erik lund"]]);
});

test("participants: a name is not marked as misspelt or autocorrected, and a phone's keyboard starts each word with a capital", async () => {
  const { input } = await mountNames();
  assert.equal(input().getAttribute("spellcheck"), "false");
  assert.equal(input().getAttribute("autocorrect"), "off", "iOS's autocorrect would change a name as the focus moves on");
  assert.equal(input().getAttribute("autocapitalize"), "words");
});

test("participants: the help text holds no count, and each change is said once, by the field's one status", async () => {
  const { view, input } = await mountNames(["Anna Berg"], [], "Skilj flera namn med komma.");
  // Every text a live region of the field takes, in order.
  const said: string[] = [];
  const last = new Map<Element, string>();
  const observer = new window.MutationObserver(() => {
    for (const region of view.container.querySelectorAll('[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])')) {
      const text = region.textContent?.trim() ?? "";
      if (text && text !== last.get(region)) said.push(text);
      last.set(region, text);
    }
  });
  observer.observe(view.container, { subtree: true, childList: true, characterData: true });
  const key = (name: string) => input().dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  const paste = (text: string) => {
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
    input().dispatchEvent(event);
  };
  await view.act(async () => type(input(), "Erik Lund"));
  await view.act(async () => key("Enter"));
  // Two lists of two in a row: the second is a change of its own, and is said too.
  await view.act(async () => paste("Sara Holm, Olle Berg"));
  await view.act(async () => paste("Li Ek; Åsa Lind"));
  await view.act(async () => key("Backspace"));
  observer.disconnect();
  const described = (input().getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
  assert.deepEqual(described, ["Skilj flera namn med komma."], "the field's help text as the form gives it, without a count of the names");
  assert.deepEqual(said, [
    "Erik Lund har lagts till.",
    "Sara Holm och Olle Berg har lagts till.",
    "Li Ek och Åsa Lind har lagts till.",
    "Åsa Lind har tagits bort.",
  ]);
});

test("participants: a name's remove button takes it away and the focus goes back to the field", async () => {
  const { view, input, shown } = await mountNames(["Anna Berg", "Erik Lund"]);
  await view.act(async () => button(view.container, "Ta bort Anna Berg")!.click());
  assert.deepEqual(shown(), ["Erik Lund"]);
  assert.equal(document.activeElement, input());
});

test("participants: removed with a finger, the focus stays off the field, so the phone's keyboard does not open", async () => {
  const { view, input, shown } = await mountNames(["Anna Berg", "Erik Lund"]);
  const press = (target: Element, pointerType: string) => {
    const down = new window.MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(down, "pointerType", { value: pointerType });
    target.dispatchEvent(down);
    (target as HTMLElement).click();
  };
  await view.act(async () => press(button(view.container, "Ta bort Anna Berg")!, "touch"));
  assert.deepEqual(shown(), ["Erik Lund"]);
  assert.notEqual(document.activeElement, input(), "a tap leaves the field alone");
  // A mouse's press after it takes the focus back to the field, as a key's does.
  await view.act(async () => press(button(view.container, "Ta bort Erik Lund")!, "mouse"));
  assert.equal(document.activeElement, input());
});

test("participants: on a phone on its side, a field offering earlier names that Safari leaves under the keyboard's suggestions is scrolled above them", async (t) => {
  const move = visualViewport(t);
  const scrolled: number[] = [];
  const scrollBy = window.scrollBy;
  window.scrollBy = ((_: number, y: number) => void scrolled.push(y)) as typeof window.scrollBy;
  t.after(() => void (window.scrollBy = scrollBy));
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const { view, input } = await mountNames([], ["Anna Berg", "Erik Lund"]);
  input().getBoundingClientRect = () => ({ top: 182, bottom: 208 }) as DOMRect;
  await view.act(async () => input().focus());
  // The keyboard and its suggestions leave 102 px, and the field, at 182-208, lies under them.
  await view.act(async () => {
    move(102, 0);
    await frame();
  });
  assert.deepEqual(scrolled, [122], "the field ends a spacing above the keyboard");
  // A browser that moved the visible part itself has shown the field.
  scrolled.length = 0;
  await view.act(async () => {
    move(102, 60);
    await frame();
  });
  assert.deepEqual(scrolled, []);
  // With Safari's bars shown the keyboard leaves nothing (Safari says -8 px): there is no place to scroll the field to.
  await view.act(async () => {
    move(-8, 0);
    await frame();
  });
  assert.deepEqual(scrolled, []);
  // A field offering nothing, Safari shows itself.
  const plain = await mountNames();
  plain.input().getBoundingClientRect = () => ({ top: 182, bottom: 208 }) as DOMRect;
  await plain.view.act(async () => plain.input().focus());
  await plain.view.act(async () => {
    move(102, 0);
    await frame();
  });
  assert.deepEqual(scrolled, []);
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
