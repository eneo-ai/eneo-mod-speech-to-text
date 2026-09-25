/**
 * The gate's own checks against pages built to fail them: a check that passes
 * these would pass the app's faults too. They run once, at one width.
 */
import { expect, test } from "@playwright/test";
import { axe, blocking, focusStop, tabWalk, targetSizes } from "./checks";

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

test("colours are measured once a colour change has ended, not halfway through it", async ({ page }) => {
  // A button enabled a moment before the scan fades from its disabled grey to its colour.
  await page.setContent(`
    <style>
      button { color: #fff; background: #ddd; border: 0; padding: 8px; transition: background-color 1s linear; }
      button.on { background: #1d4ed8; }
    </style>
    <main><h1>Prov</h1><button>Godkänn</button></main>`);
  await page.evaluate(() => requestAnimationFrame(() => document.querySelector("button")!.classList.add("on")));
  await page.waitForFunction(() => document.getAnimations().length > 0);
  const scan = await axe(page);
  expect(scan.violations.map((v) => v.id)).not.toContain("color-contrast");
});

test("a focus outline that cannot be seen is not taken for a focus indicator", async ({ page }) => {
  await page.setContent(`
    <style>
      body { background: #fff; }
      button { background: #fff; color: #111; border: 1px solid #767676; outline: none; }
      #white:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
      #black:focus-visible { outline: 3px solid #111; outline-offset: 2px; }
    </style>
    <p><button id="white">Vit ring</button></p>
    <p><button id="black">Svart ring</button></p>`);
  await page.keyboard.press("Tab");
  expect((await focusStop(page))?.indicator, "white on white").toBe(false);
  await page.keyboard.press("Tab");
  expect((await focusStop(page))?.indicator, "black on white").toBe(true);
});

test("focus is measured where a phone shows it, also on a page wider than the phone", async ({ browser }) => {
  // Content past the edge makes a phone's layout viewport wider than the screen; scrolled down, the box a script
  // reads and the picture of the screen then disagree by the visual viewport's offset.
  const context = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.setContent(`
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body { margin: 0; font: 16px sans-serif; }
      button { margin: 8px; outline: none; }
      button:focus-visible { outline: 3px solid #111; outline-offset: 2px; }
    </style>
    <div style="width: 360px; height: 1200px"></div>
    <button>Längst ner</button>
    <div style="height: 900px"></div>`);
  await page.keyboard.press("Tab");
  expect((await focusStop(page))?.indicator, "a black ring on white").toBe(true);
  await context.close();
});

test("a hit area grown by a pseudo-element is measured from the padding box, where its insets apply", async ({ page }) => {
  // 24 px across the border box, 16 px inside its 4 px border: grown by 12 px, the hit area is 40 px, not 48.
  await page.setContent(`
    <style>
      button { position: relative; box-sizing: border-box; width: 24px; height: 24px; border: 4px solid #333; padding: 0; }
      button::after { content: ""; position: absolute; inset: -12px; }
    </style>
    <button aria-label="Liten"></button>`);
  expect(await targetSizes(page, 44, false)).toEqual(['button "Liten" 24×24']);
});
