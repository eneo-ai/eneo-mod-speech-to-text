/**
 * The participants' field as it is laid out: "Lägg till" stands beside the input from the start and is off until a name
 * is typed, so the input keeps its width as a name comes and goes; the two are one height, and their words stand on one
 * baseline. A long name wraps inside its chip, and every chip's remove button takes a press across its whole target.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./gate";
import { setup, STATES } from "./screens";

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

test("a long name wraps inside its chip, in the field's column, and every remove button takes a press across its target", async ({ page }, info) => {
  test.skip(!["phone-320-light", "laptop-1440-light"].includes(info.project.name), "the narrowest phone, and a mouse");
  await STATES.find((state) => state.name === "setup-participants-long")!.go(page, info);
  // The house bar under a finger, WCAG 2.5.8's with a mouse.
  const target = (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) ? 44 : 24;
  const chips = await page.evaluate(() => {
    const names = document.querySelector('ul[aria-label="Tillagda namn"]')!;
    return [...names.querySelectorAll<HTMLButtonElement>('button[aria-label^="Ta bort "]')].map((button) => {
      // A press is found where the window shows it.
      button.scrollIntoView({ block: "center", behavior: "instant" });
      const list = names.getBoundingClientRect();
      const chip = button.closest(".astryx-token")!.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      const [x, y] = [b.left + b.width / 2, b.top + b.height / 2];
      const presses = (dx: number, dy: number) => {
        const hit = document.elementFromPoint(x + dx, y + dy);
        return hit !== null && (hit === button || button.contains(hit));
      };
      // How far a press from the button's centre still lands on it, along each axis: the target its box and its
      // ::after give it, less what clips or covers them.
      const reach = (dx: number, dy: number) => {
        let n = 0;
        while (n < 30 && presses(dx * (n + 1), dy * (n + 1))) n++;
        return n;
      };
      return {
        name: button.getAttribute("aria-label")!.slice("Ta bort ".length),
        inColumn: chip.left >= list.left - 0.5 && chip.right <= list.right + 0.5,
        across: presses(0, 0) ? reach(-1, 0) + 1 + reach(1, 0) : 0,
        down: presses(0, 0) ? reach(0, -1) + 1 + reach(0, 1) : 0,
      };
    });
  });
  expect(chips.length, "every name has its chip").toBe(6);
  expect(chips.filter((chip) => !chip.inColumn).map((chip) => chip.name), "chips past the field's column").toEqual([]);
  const small = chips.filter((chip) => chip.across < target || chip.down < target).map((chip) => `${chip.name}: ${chip.across}×${chip.down}`);
  expect(small, `remove buttons that take a press over less than ${target} px`).toEqual([]);
});
