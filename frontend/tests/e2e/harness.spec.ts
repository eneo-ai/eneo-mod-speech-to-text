/**
 * The gate's own checks against pages built to fail them: a check that passes
 * these would pass the app's faults too. They run once, at one width.
 */
import { expect, test } from "@playwright/test";
import { axe, blocking, tabWalk } from "./checks";

test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1440-light", "the checks' own tests run once"));

test("a keyboard trap that cycles between two controls is caught", async ({ page }) => {
  await page.setContent(`
    <button id="a">A</button><button id="b">B</button><button id="c">C</button>
    <script>
      // Tab from B goes back to A, and Shift+Tab from A to B: focus never reaches C or leaves.
      document.getElementById("b").addEventListener("keydown", (e) => {
        if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); document.getElementById("a").focus(); }
      });
    </script>`);
  const { left } = await tabWalk(page, 12);
  expect(left, "the walk says focus never left the page").toBe(false);
});

test("a WCAG violation blocks the gate whatever axe calls its impact", async ({ page }) => {
  // html-xml-lang-mismatch is WCAG 3.1.1 and axe calls it moderate.
  await page.setContent(`<html lang="sv" xml:lang="en"><head><title>Prov</title></head><body><main><h1>Prov</h1></main></body></html>`);
  const scan = await axe(page);
  expect(blocking(scan.violations).map((v) => v.id)).toContain("html-xml-lang-mismatch");
});
