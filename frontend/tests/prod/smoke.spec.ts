import { expect, test, type Page } from "@playwright/test";

/** What the browser reports as broken or blocked (a Content-Security-Policy refusal is a console error). */
function problemsOf(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => message.type() === "error" && problems.push(message.text()));
  page.on("pageerror", (error) => problems.push(String(error)));
  return problems;
}

test("the design system is styled, themed and working in the built app", async ({ page }) => {
  const problems = problemsOf(page);
  await page.goto("/dev/foundation");
  await expect(page.getByRole("heading", { name: "Grundkontroll" })).toBeVisible();
  const primary = page.getByRole("button", { name: "Primär" });
  // A lost cascade layer shows as a button without padding; a theme that did not load, as another accent.
  expect(await primary.evaluate((button) => getComputedStyle(button).paddingInline)).not.toBe("0px");
  expect(await primary.evaluate((button) => getComputedStyle(button).backgroundColor)).toBe("rgb(0, 69, 149)");
  await page.getByRole("button", { name: "Konto" }).click();
  await expect(page.getByRole("menuitem", { name: "Logga ut" })).toBeVisible();
  await page.keyboard.press("Escape");
  await primary.click();
  const dialog = page.getByRole("alertdialog", { name: "Du behöver logga in igen" });
  await expect(dialog).toBeVisible();
  // A required dialog stays on Escape.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(problems).toEqual([]);
});

test("a signed-in page of the built app loads with nothing blocked or broken", async ({ page }) => {
  const problems = problemsOf(page);
  await page.goto("/flows");
  await expect(page.getByRole("heading", { name: "Välj ett flöde" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Nämndmöte till rapport/ })).toBeVisible();
  expect(problems).toEqual([]);
});
