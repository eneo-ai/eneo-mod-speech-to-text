/**
 * A deployment with its own accent colour (ORGANIZATION_ACCENT, a green here): nothing the page paints keeps the
 * default blue, the accent is the colour of buttons and focus rings, and it is there from the first paint. Run by
 * `npm run test:a11y:branding`, whose stub is that deployment; the scans (axe, targets, reflow) of the branding-*
 * states are a11y.spec.ts's.
 */
import { expect, test, type Page } from "@playwright/test";
import { stopProblems, tabWalk } from "./checks";
import { STATES } from "./screens";

const VARIANT = process.env.STUB_BRANDING;
const ACCENT = { light: "rgb(30, 123, 52)", dark: "rgb(42, 174, 74)" } as const; // #1E7B34, and #2AAE4A derived from it
const states = STATES.filter((state) => state.name.startsWith("branding-"));

test.beforeEach(({}, info) =>
  test.skip(!VARIANT, "needs the stub as a deployment with its own organisation: npm run test:a11y:branding"),
);

const mode = (page: Page) => page.evaluate(() => (document.documentElement.classList.contains("dark") ? "dark" : "light") as "dark" | "light");

for (const state of states) {
  test(`${state.name}: nothing keeps the default blue`, async ({ page }, info) => {
    test.skip(info.project.name === "forced-colors", "system colours there");
    test.skip(state.only ? !state.only(info) : false, "not on this width");
    await state.go(page, info);
    const blue = await page.evaluate(() => {
      type Rgba = [number, number, number, number];
      // Computed colours come as rgb() or, for a mix, color(srgb r g b / a).
      const parse = (text: string): Rgba[] =>
        [...text.matchAll(/rgba?\(([^)]*)\)|color\(srgb ([^)]*)\)/g)].map((match) => {
          const numbers = (match[1] ?? match[2]).split(/[\s,/]+/).filter(Boolean).map(Number);
          const scale = match[2] === undefined ? 1 : 255;
          return [numbers[0] * scale, numbers[1] * scale, numbers[2] * scale, numbers[3] ?? 1];
        });
      // A saturated colour whose hue is blue. Every neutral of the themes has a chroma under 0.08; the old blues over 0.1.
      const isBlue = ([r, g, b, a]: Rgba) => {
        const max = Math.max(r, g, b);
        const chroma = (max - Math.min(r, g, b)) / 255;
        if (a < 0.05 || chroma < 0.1 || max !== b) return false;
        const hue = 60 * (4 + (r - g) / (max - Math.min(r, g, b)));
        return hue >= 195 && hue <= 255;
      };
      const found: string[] = [];
      for (const element of document.querySelectorAll("body *")) {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        // A shadow layer of no size paints nothing: Tailwind's ring, 0 0 0 0 in its default blue, sits in every shadow.
        const painted = style.boxShadow
          .split(/,(?![^(]*\))/)
          .filter((layer) => (layer.replace(/(rgba?|color)\([^)]*\)/g, "").match(/-?[\d.]+px/g) ?? []).some((length) => parseFloat(length) !== 0))
          .join(",");
        const own: [string, string][] = [
          ["color", style.color],
          ["background", style.backgroundColor],
          ["caret", style.caretColor],
          ["text-decoration", style.textDecorationColor],
          ["fill", style.fill],
          ["stroke", style.stroke],
          ["box-shadow", painted],
        ];
        for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
          if (parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== "none") own.push([`border-${side}`, style[`border${side}Color`]]);
        }
        if (parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== "none") own.push(["outline", style.outlineColor]);
        for (const [property, value] of own) {
          if (parse(value).some(isBlue)) found.push(`${element.tagName.toLowerCase()}.${String(element.getAttribute("class") ?? "").split(" ")[0]} ${property}: ${value}`);
        }
      }
      return found;
    });
    expect(blue, "elements painted in a blue").toEqual([]);
  });
}

for (const name of ["signin-sso", "flow-list"]) {
  test(`branding-${VARIANT}-${name}: every stop shows its focus indicator`, async ({ page }, info) => {
    const state = states.find((candidate) => candidate.name === `branding-${VARIANT}-${name}`)!;
    await state.go(page, info);
    const { stops, left } = await tabWalk(page);
    expect(stops.length, "something to focus").toBeGreaterThan(0);
    expect.soft(left, "focus leaves the page").toBe(true);
    expect.soft(stopProblems(stops), "focus visible and unobscured").toEqual([]);
  });
}

test("the accent is the colour of the primary button and of every focus ring", async ({ page }, info) => {
  test.skip(info.project.name === "forced-colors", "system colours there");
  const ring = (selector: string) => page.evaluate((s) => getComputedStyle(document.activeElement!.closest(s)!).outlineColor, selector);
  await states.find((state) => state.name === `branding-${VARIANT}-signin-sso`)!.go(page, info);
  const accent = ACCENT[await mode(page)];
  const login = page.getByRole("button", { name: "Logga in med Eneo" });
  await login.focus();
  expect(await ring("button"), "the button's ring").toBe(accent);
  expect(await login.evaluate((button) => getComputedStyle(button).backgroundColor), "the button").toBe(accent);
  // A field has its own ring: the setup page's, where a person types.
  await states.find((state) => state.name === `branding-${VARIANT}-setup`)!.go(page, info);
  const field = page.locator(".astryx-text-input input:visible").first();
  await expect(field, "a field to focus on the setup page").toBeVisible();
  await field.focus();
  expect(await ring(".astryx-text-input"), "the field's ring").toBe(accent);
});

test("the stylesheet is in the head, holds the first paint and is the colour with scripts blocked", async ({ browser, baseURL }, info) => {
  test.skip(info.project.name !== "laptop-1440-light", "one width is enough");
  const context = await browser.newContext({ javaScriptEnabled: false, colorScheme: "light" });
  const page = await context.newPage();
  const response = await page.goto(`${baseURL}/`);
  expect(response?.ok()).toBe(true);
  const link = await page.evaluate(() => {
    const element = document.querySelector<HTMLLinkElement>('head > link[rel="stylesheet"][href="/api/branding/theme.css"]');
    return element && { blocking: !element.media && !element.disabled && !element.hasAttribute("async") && element.sheet !== null };
  });
  expect(link, "a plain stylesheet link in the head, already applied").toEqual({ blocking: true });
  // The same colour as a probe on the theme root, where the design system's tokens live.
  const painted = await page.evaluate(() => {
    const root = document.querySelector('[data-astryx-theme="eneo"]')!;
    const probe = document.createElement("span");
    probe.style.background = "var(--color-accent)";
    root.append(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  });
  expect(painted).toBe(ACCENT.light);
  await context.close();
});
