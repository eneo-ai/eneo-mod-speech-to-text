/**
 * The participants' field as it is laid out: "Lägg till" stands beside the input from the start and is off until a name
 * is typed, so the input keeps its width as a name comes and goes; the two are one height, and their words stand on one
 * baseline.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./gate";
import { setup } from "./screens";

/** The input's box, Lägg till's box, and the baseline each one's words stand on, in whole CSS px. */
function row(page: Page) {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('[data-detail-field="deltagare"]')!;
    const add = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Lägg till")!;
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    };
    // Where a box of no height at the baseline of a line ends: the words' baseline.
    const mark = () => {
      const span = document.createElement("span");
      span.style.cssText = "display:inline-block;width:0;height:0";
      return span;
    };
    const words = [...add.querySelectorAll("span")].find((span) => [...span.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()))!;
    const atButton = words.appendChild(mark());
    const buttonBaseline = atButton.getBoundingClientRect().bottom;
    atButton.remove();
    // An input's words are a line of its font, centred in its content box: the same line, set where they are.
    const s = getComputedStyle(input);
    const r = input.getBoundingClientRect();
    const content = r.height - parseFloat(s.borderTopWidth) - parseFloat(s.borderBottomWidth) - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom);
    const line = Object.assign(document.createElement("div"), { textContent: "x" });
    line.style.cssText = `position:fixed;left:0;top:${r.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop) + (content - parseFloat(s.lineHeight)) / 2}px;font:${s.font};line-height:${s.lineHeight}`;
    const atInput = line.appendChild(mark());
    document.body.append(line);
    const inputBaseline = atInput.getBoundingClientRect().bottom;
    line.remove();
    const field = input.closest(".astryx-text-input")!;
    // The corners where the field and the button meet: the field's end, the button's start.
    const corners = [getComputedStyle(field), getComputedStyle(add)].flatMap((style, i) =>
      i === 0 ? [style.borderStartEndRadius, style.borderEndEndRadius] : [style.borderStartStartRadius, style.borderEndStartRadius],
    );
    return { field: box(field), button: box(add), inputBaseline, buttonBaseline, corners };
  });
}

test("Lägg till stands beside the field, level with it and off until a name is typed, and the field keeps its width", async ({ page }, info) => {
  test.skip(!["phone-390-light", "laptop-1440-light"].includes(info.project.name), "a finger's sizes and a mouse's");
  await setup(page);
  const input = page.getByRole("textbox", { name: /^Deltagare/ });
  const add = page.getByRole("button", { name: "Lägg till", exact: true });
  await expect(add, "there before a name is typed, and off").toBeDisabled();
  const empty = await row(page);
  await input.fill("Sara Holm");
  await expect(add).toBeEnabled();
  const typed = await row(page);
  expect(typed.field, "the field keeps its box while a name is typed").toEqual(empty.field);
  expect(typed.button, "and Lägg till its own").toEqual(empty.button);
  expect([typed.button.top, typed.button.height], "Lägg till is the field's height, on its line").toEqual([typed.field.top, typed.field.height]);
  expect(Math.abs(typed.buttonBaseline - typed.inputBaseline), "their words stand on one baseline").toBeLessThanOrEqual(1);
  expect(typed.corners, "one piece: square where the field and the button meet").toEqual(["0px", "0px", "0px", "0px"]);
  await input.fill("");
  await expect(add, "off again once the field is empty").toBeDisabled();
});
