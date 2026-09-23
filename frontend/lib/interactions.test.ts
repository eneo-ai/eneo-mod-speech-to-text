import assert from "node:assert/strict";
import test from "node:test";

import { installDom, type } from "./test-dom";

installDom();

async function mount(element: import("react").ReactElement) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    act,
    unmount: () => act(async () => root.unmount()).then(() => container.remove()),
  };
}

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name) ?? null;

test("participants: moving from the field to Lägg till and on keeps the typed name", async () => {
  const { createElement } = await import("react");
  const { ParticipantsInput } = await import("../components/flow/ParticipantsInput");
  const changes: string[][] = [];
  const outside = document.createElement("button");
  document.body.append(outside);
  const view = await mount(
    createElement(ParticipantsInput, { id: "namn", names: [], onChange: (names: string[]) => changes.push(names), suggestions: [] }),
  );
  const field = view.container.querySelector<HTMLInputElement>("#namn")!;
  await view.act(async () => field.focus());
  await view.act(async () => type(field, "Anna Berg"));
  const add = button(view.container, "Lägg till")!;
  assert.ok(add, "Lägg till shows while a name is typed");
  // Tab to the button: not yet added, the button adds it.
  await view.act(async () => add.focus());
  assert.deepEqual(changes, []);
  // Tab on past it: the name is not lost.
  await view.act(async () => outside.focus());
  assert.deepEqual(changes, [["Anna Berg"]]);
  await view.unmount();
  outside.remove();
});

test("participants: Tab to Lägg till and Enter adds the name, and focus goes back to the field", async () => {
  const { createElement } = await import("react");
  const { ParticipantsInput } = await import("../components/flow/ParticipantsInput");
  const changes: string[][] = [];
  const view = await mount(
    createElement(ParticipantsInput, { id: "namn2", names: [], onChange: (names: string[]) => changes.push(names), suggestions: [] }),
  );
  const field = view.container.querySelector<HTMLInputElement>("#namn2")!;
  await view.act(async () => field.focus());
  await view.act(async () => type(field, "Erik Lund"));
  const add = button(view.container, "Lägg till")!;
  await view.act(async () => add.focus());
  await view.act(async () => add.click());
  assert.deepEqual(changes, [["Erik Lund"]], "added once");
  assert.equal(document.activeElement, field);
  await view.unmount();
});
