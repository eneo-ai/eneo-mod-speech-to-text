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

test("a field's box counts as its control's target only for the control it activates", async ({ page }) => {
  await page.setContent(`
    <style>
      .astryx-text-input, .plain { display: flex; align-items: center; height: 44px; width: 240px; border: 1px solid #767676; }
      input { height: 20px; border: 0; }
      button { width: 20px; height: 20px; padding: 0; margin-left: 40px; }
    </style>
    <div class="astryx-text-input"><input aria-label="I fältets ruta"><button aria-label="Rensa"></button></div>
    <div class="plain" style="margin-top: 40px"><input aria-label="I en vanlig ruta"></div>`);
  // The design system's field is credited with its box; a control of its own inside that box, and a field in any
  // other box, are measured as they are.
  expect(await targetSizes(page, 44, false)).toEqual(['button "Rensa" 20×20', expect.stringMatching(/^input "I en vanlig ruta" \d+×20$/)]);
});

test("the design system's field box does activate its control, so crediting it is true", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${baseURL}/dev/foundation`);
  for (const [name, selector] of [["Ärende", ".astryx-text-input"], ["Talare", ".astryx-selector"]] as const) {
    const control = page.locator(`${selector} :is(input, [role="combobox"])`).first();
    const box = (await page.locator(selector).first().boundingBox())!;
    expect(box.height, `${name}: the box is a 44 px target on a touch screen`).toBeGreaterThanOrEqual(44);
    // The box's own edge, outside the control inside it.
    await page.touchscreen.tap(box.x + box.width / 2, box.y + 2);
    // A text field takes the focus; a picker opens.
    if (selector === ".astryx-selector") await expect(control, `${name}: a tap on the box's edge opens the picker`).toHaveAttribute("aria-expanded", "true");
    else await expect(control, `${name}: a tap on the box's edge reaches the field`).toBeFocused();
    await page.keyboard.press("Escape");
  }
  await context.close();
});

test("a target in an open modal dialog is measured even under an inert ancestor", async ({ page }) => {
  await page.setContent(`<div inert><dialog><button aria-label="Liten" style="width: 10px; height: 10px; padding: 0"></button></dialog></div>`);
  await page.evaluate(() => document.querySelector("dialog")!.showModal());
  expect(await targetSizes(page, 24, false)).toEqual(['button "Liten" 10×10']);
});
