/**
 * What a page costs to load, on the build that ships, behind the real backend: the compressed JS and CSS it transfers
 * against weight-budget.json, and that the built theme is used instead of being generated in the browser.
 * Chromium only (`@chromium` in the titles): it is the engine that reports each request's transfer size.
 *
 * Each budget is the measured value rounded up to the next 5 KB (numbers and dates: docs/adr/0007, and the pull request
 * that last changed them). A change that raises one says why in its pull request.
 */
import { expect, type Page } from "@playwright/test";
import { test } from "../e2e/auth";
import ids from "../fixtures/ids.json";
import budget from "./weight-budget.json";

type Path = keyof typeof budget;

/** A heading each page shows once the stub has answered, so a page that shows an error is never measured. */
const HEADING: Record<Path, string> = {
  "/flows": "Välj ett flöde",
  "/flows/:id": "Hur vill du lägga till ljudet?",
};

/** The address behind each budget's label: the stub's first flow stands for any flow. */
const ADDRESS: Record<Path, string> = {
  "/flows": "/flows",
  "/flows/:id": `/flows/${ids.flows.flow1}`,
};

/** Loads a page and returns the JS and CSS it transferred, in KB: compressed bodies plus headers. */
async function transferredKB(page: Page, path: Path) {
  const kb = { script: 0, stylesheet: 0 };
  const measured: Promise<void>[] = [];
  page.on("response", (response) => {
    const request = response.request();
    const type = request.resourceType();
    if (type !== "script" && type !== "stylesheet") return;
    measured.push(
      request.sizes().then((sizes) => {
        kb[type] += (sizes.responseBodySize + sizes.responseHeadersSize) / 1024;
      }),
    );
  });
  await page.goto(ADDRESS[path], { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: HEADING[path] })).toBeVisible();
  await Promise.all(measured);
  return { jsKB: kb.script, cssKB: kb.stylesheet };
}

for (const path of Object.keys(budget) as Path[]) {
  test(`${path} stays within its page-weight budget @chromium`, async ({ session, page }) => {
    expect(session.user).toBeTruthy();
    const { jsKB, cssKB } = await transferredKB(page, path);
    console.log(`${path}: ${jsKB.toFixed(1)} KB of JS, ${cssKB.toFixed(1)} KB of CSS`);
    const rule = "Raise the budget only with a reason in the pull request; Phase 8 returns it to the 2026-10-01 baseline.";
    expect.soft(jsKB, `${path} loads ${jsKB.toFixed(1)} KB of JS, the budget is ${budget[path].jsKB} KB. ${rule}`).toBeLessThanOrEqual(budget[path].jsKB);
    expect.soft(cssKB, `${path} loads ${cssKB.toFixed(1)} KB of CSS, the budget is ${budget[path].cssKB} KB. ${rule}`).toBeLessThanOrEqual(budget[path].cssKB);
  });
}

test("the built theme is used: the browser generates no theme styles @chromium", async ({ session, page }) => {
  expect(session.user).toBeTruthy();
  await page.goto("/flows", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: HEADING["/flows"] })).toBeVisible();
  await expect(
    page.locator("style[data-astryx-theme], style[data-astryx-theme-prose], style[data-astryx-theme-base]"),
    "a <style data-astryx-theme*> means the theme is built in the browser on every page load: import the built theme, kit/theme/built/eneo",
  ).toHaveCount(0);
});
