import { expect, test } from "./gate";
import { isLaptop, result, STATES } from "./screens";

async function hasOneFieldFrame(field: import("@playwright/test").Locator) {
  expect(await field.evaluate((control) => getComputedStyle(control).outlineStyle), "the inner control has no second outline").toBe("none");
  expect(await field.evaluate((control) => {
    for (let parent = control.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0) return true;
    }
    return false;
  }), "the themed field frame remains visible").toBe(true);
}

test("the correction field has one focus frame around its rounded edge", async ({ page }, info) => {
  await STATES.find((state) => state.name === "result-correction-open")!.go(page, info);
  await hasOneFieldFrame(page.getByRole("textbox", { name: /^Rätta/ }));
});

test("the search field has one focus frame around its rounded edge", async ({ page }, info) => {
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const field = page.getByRole("textbox", { name: "Sök i transkriberingen" });
  await field.focus();
  await hasOneFieldFrame(field);
});
