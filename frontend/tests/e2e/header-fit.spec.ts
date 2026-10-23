/**
 * The top bar at the narrowest width with the text spacing WCAG 1.4.12 lets a reader set. The design system's bar
 * never shrinks the brand, so a brand that is too wide runs into the account button beside it: the product's name is
 * then covered, or cut to "Tal till …". They keep a gap's width between them.
 *
 * And an organisation's name without a logo (components/Brand.tsx): on a phone it stands on the bar's one line, or, where
 * it has no room, is left out with its divider; from 640 px it takes two lines at most. The link names it whole.
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./gate";
import { addStyles, TEXT_SPACING } from "./checks";
import { flows } from "./screens";

const GAP = 8;

test("at 320 px with text spacing the brand and the account button keep apart, and the name is whole", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-320-light", "the narrowest width");
  await flows(page);
  await addStyles(page, TEXT_SPACING);
  const brand = page.getByRole("link", { name: /^Tal till text –/ });
  const account = page.getByRole("button", { name: /^Öppna konto för/ });
  const [brandBox, accountBox] = [await brand.boundingBox(), await account.boundingBox()];
  expect(brandBox && accountBox, "both are shown").toBeTruthy();
  expect(accountBox!.x - (brandBox!.x + brandBox!.width), "the room between them").toBeGreaterThanOrEqual(GAP);
  const name = brand.getByText("Tal till text", { exact: true });
  expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth), "the name is not cut off").toBe(true);
});

/** The flow list of a deployment that has a name and no logo: the page's branding marker, which it reads before it renders. */
async function nameOnly(page: Page, name: string) {
  await page.route("**/flows", async (route) => {
    const response = await route.fetch();
    const marker = JSON.stringify({ organization: { name, logo: null, dark_logo: false, logo_sizes: null } }).replace(/"/g, "&quot;");
    const body = (await response.text()).replace(/<meta name="eneo-branding" content="[^"]*"/, `<meta name="eneo-branding" content="${marker}"`);
    await route.fulfill({ response, body });
  });
  await flows(page);
  await page.evaluate(() => document.fonts.ready);
}

/** How many lines an element's text takes. */
const lines = (element: Element) => Math.round(element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight));

const LONG = "Förvaltningen för kultur, fritid och samhällsbyggnad";
const NAMES: [project: string, name: string, most: number][] = [
  ["phone-320-light", LONG, 0],
  ["phone-390-light", LONG, 0],
  ["phone-390-light", "Umeå kommun", 1],
  ["laptop-1440-light", LONG, 2],
];

for (const [project, name, most] of NAMES) {
  test(`a name without a logo, ${name.length} characters, ${most ? `in ${most === 1 ? "one line" : `${most} lines at most`}` : "left out"}, on ${project}`, async ({ page }, info) => {
    test.skip(info.project.name !== project, "its width");
    await nameOnly(page, name);
    const brand = page.getByRole("link", { name: `Tal till text – ${name}`, exact: true });
    const mark = brand.getByText(name, { exact: true });
    await expect(brand, "the link names the organisation whole").toBeVisible();
    if (most) {
      await expect(mark).toBeVisible();
      expect(await mark.evaluate(lines), "the name's lines").toBeLessThanOrEqual(most);
    } else {
      await expect(mark, "no room for the name: it is left out").toHaveCount(0);
      expect(await brand.innerText(), "the bar reads the product's name alone, without the divider").toBe("Tal till text");
    }
    expect(await brand.getByText("Tal till text", { exact: true }).evaluate(lines), "the product's name on one line").toBe(1);
    const account = page.getByRole("button", { name: /^Öppna konto för/ });
    const [brandBox, accountBox] = [await brand.boundingBox(), await account.boundingBox()];
    expect(accountBox!.x - (brandBox!.x + brandBox!.width), "the brand stops before the account").toBeGreaterThanOrEqual(0);
    if (most) return;
    // Measured again when the window changes: a wide one has room for the name, in two lines at most.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(mark).toBeVisible();
    expect(await mark.evaluate(lines)).toBeLessThanOrEqual(2);
    await page.setViewportSize(info.project.use.viewport!);
    await expect(mark).toHaveCount(0);
  });
}

// The reader's own text size (iOS's largest sizes set the page's root at 47 and 53 px) and a phone's 200 % page zoom (a
// 412 px phone at 206 CSS px): the logo leaves the bar with its divider where it has no room beside the product's name, as
// a name does. The link still names the organisation.
const LARGE: [width: number, height: number, root: number][] = [
  [390, 844, 40],
  [390, 844, 53],
  [206, 395, 16],
];
for (const [width, height, root] of LARGE) {
  test(`at ${width} px with ${root} px text the product's name and the account keep apart, and the bar does not overflow`, async ({ page }, info) => {
    test.skip(info.project.name !== "phone-390-light", "the window's size and text are set here");
    await page.setViewportSize({ width, height });
    await flows(page);
    await addStyles(page, `html { font-size: ${root}px !important; }`);
    const brand = page.getByRole("link", { name: /^Tal till text –/ });
    const account = page.getByRole("button", { name: /^Öppna konto för/ });
    await expect(brand).toBeVisible();
    await expect.poll(async () => {
      const [brandBox, accountBox] = [await brand.boundingBox(), await account.boundingBox()];
      return accountBox!.x - (brandBox!.x + brandBox!.width);
    }, "the room between them").toBeGreaterThanOrEqual(0);
    const name = brand.getByText("Tal till text", { exact: true });
    expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth), "the name is not cut off").toBe(true);
    expect(await page.locator(".astryx-top-nav").evaluate((bar) => bar.scrollWidth <= bar.clientWidth), "nothing past the bar's edge").toBe(true);
  });
}
