/**
 * What a page costs to load, on the production build: the compressed JS and CSS it transfers against
 * weight-budget.json, and that the built theme is used instead of being generated in the browser.
 * Chromium only: it is the engine that reports each request's transfer size.
 *
 * This build carries app/dev/foundation (FOUNDATION_CHECK=1, for the smoke tests), and that page moves shared chunks:
 * about 6.5 KB more than the image, which is built without it (2026-10-01: /flows 291.7 KB, /flows/flow-1 424.1 KB
 * there, 298.1 and 430.7 here). The budgets follow this build. They go back to the baseline in Phase 8.
 * The budget is the foundation's numbers plus lucide-react 1.x's Icon runtime (+1 KB on /flows). Phase 8's reset
 * target (226 KB on /flows, 359 KB on /flows/flow-1) was measured with lucide-react 0.451: re-measure it with 1.x.
 */
import { expect, test, type Page } from "@playwright/test";
import budget from "./weight-budget.json";

test.beforeEach(({}, info) => test.skip(info.project.name !== "chromium", "only Chromium reports transfer sizes"));

type Path = keyof typeof budget;

/** A heading each page shows once the stub has answered, so a page that shows an error is never measured. */
const HEADING: Record<Path, string> = {
  "/flows": "Välj ett flöde",
  "/flows/flow-1": "Hur vill du lägga till ljudet?",
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
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: HEADING[path] })).toBeVisible();
  await Promise.all(measured);
  return { jsKB: kb.script, cssKB: kb.stylesheet };
}

for (const path of Object.keys(budget) as Path[]) {
  test(`${path} stays within its page-weight budget`, async ({ page }) => {
    const { jsKB, cssKB } = await transferredKB(page, path);
    const rule = "Raise the budget only with a reason in the pull request; Phase 8 returns it to the 2026-10-01 baseline.";
    expect.soft(jsKB, `${path} loads ${jsKB.toFixed(1)} KB of JS, the budget is ${budget[path].jsKB} KB. ${rule}`).toBeLessThanOrEqual(budget[path].jsKB);
    expect.soft(cssKB, `${path} loads ${cssKB.toFixed(1)} KB of CSS, the budget is ${budget[path].cssKB} KB. ${rule}`).toBeLessThanOrEqual(budget[path].cssKB);
  });
}

test("the built theme is used: the browser generates no theme styles", async ({ page }) => {
  await page.goto("/flows", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: HEADING["/flows"] })).toBeVisible();
  await expect(
    page.locator("style[data-astryx-theme], style[data-astryx-theme-prose], style[data-astryx-theme-base]"),
    "a <style data-astryx-theme*> means the theme is built in the browser on every page load: import the built theme, kit/theme/built/eneo",
  ).toHaveCount(0);
});
