import { expect, type Page } from "@playwright/test";
import { test } from "../e2e/auth";

/** What the browser reports as broken or blocked (a Content-Security-Policy refusal is a console error). */
function problemsOf(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => message.type() === "error" && problems.push(message.text()));
  page.on("pageerror", (error) => problems.push(String(error)));
  return problems;
}

test("the design system is styled, themed and working in the built app @fixture", async ({ page }) => {
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

test("a signed-in page of the built app loads with nothing blocked or broken", async ({ session, page }) => {
  expect(session.user).toBeTruthy();
  const problems = problemsOf(page);
  await page.goto("/flows");
  await expect(page.getByRole("heading", { name: "Välj ett flöde" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Nämndmöte till rapport/ })).toBeVisible();
  expect(problems).toEqual([]);
});

test("a navigation of the built app is announced through a live region, with nothing blocked", async ({ session, page }) => {
  expect(session.user).toBeTruthy();
  const problems = problemsOf(page);
  const violations: string[] = [];
  await page.exposeFunction("blocked", (what: string) => violations.push(what));
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (event) => void (window as unknown as { blocked(what: string): void }).blocked(`${event.violatedDirective} ${event.blockedURI}`)),
  );
  await page.goto("/flows");
  await expect(page.getByRole("heading", { name: "Välj ett flöde" })).toBeVisible();
  await page.getByRole("link", { name: /Nämndmöte till rapport/ }).click();
  // The flow's own heading: every engine has it, where "Hur vill du lägga till ljudet?" is there only for one that can record
  // (WebKit on Linux has no MediaRecorder, and its page offers an upload alone).
  await expect(page.getByRole("heading", { level: 1, name: "Nämndmöte till rapport" })).toBeVisible();
  // The design system's live region sets its hidden style from script, which the policy allows (no 'unsafe-inline').
  await expect(page.locator('[data-astryx-live-region="polite"]')).toHaveText("Nämndmöte till rapport · Tal till text");
  expect(violations).toEqual([]);
  expect(problems).toEqual([]);
});
