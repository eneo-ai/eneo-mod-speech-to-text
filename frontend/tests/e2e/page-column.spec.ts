/**
 * The page's column: what a page says starts where the bar's brand does, at every width, so the bar and the page share
 * one left edge, and the account ends where the column does (styles/globals.css aligns the bar to the column).
 */
import { expect, test } from "./gate";

test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1440-light", "the widths are set here"));

test("a page that cannot be shown stands in the page's column: its heading starts where the brand does", async ({ page }) => {
  for (const [width, height] of [
    [1366, 768],
    [2560, 1440],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto("/finns-inte");
    const heading = page.getByRole("heading", { level: 1, name: "Sidan finns inte." });
    const brand = page.getByRole("banner").getByRole("img").first();
    await expect(heading).toBeVisible();
    const [headingBox, brandBox] = [await heading.boundingBox(), await brand.boundingBox()];
    expect(Math.abs(headingBox!.x - brandBox!.x), `at ${width} px, the heading under the brand`).toBeLessThanOrEqual(1);
  }
});

test("the account button ends where the page's column does", async ({ page }) => {
  for (const [width, height] of [
    [1366, 768],
    [1440, 900],
    [3440, 1440],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    const account = page.getByRole("button", { name: /^Öppna konto för/ });
    await expect(account).toBeVisible();
    const accountBox = (await account.boundingBox())!;
    // The column is --module-page-width wide and centred in the window.
    const columnEnd = await page.evaluate(() => {
      const probe = Object.assign(document.createElement("div"), { style: "width: var(--module-page-width)" });
      document.body.append(probe);
      const column = probe.getBoundingClientRect().width;
      probe.remove();
      return (document.documentElement.clientWidth + column) / 2;
    });
    expect(Math.abs(accountBox.x + accountBox.width - columnEnd), `at ${width} px, the account under the column's end`).toBeLessThanOrEqual(3);
  }
});

/** How wide a paragraph is in its own font's "0"s: a line of 55ch holds about 75 characters of Figtree. */
const measure = (paragraph: import("@playwright/test").Locator) =>
  paragraph.evaluate((p) => {
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(10);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
    p.append(probe);
    const ch = probe.getBoundingClientRect().width / 10;
    probe.remove();
    return Math.round(p.getBoundingClientRect().width / ch);
  });

for (const [state, width, words] of [
  ["setup", 820, /^Inspelningen sparas/],
  ["setup", 1440, /^Inspelningen sparas/],
  ["ready", 1440, /skickar inspelningen till Eneo/],
  ["setup-speakers-blocked", 1440, /^Flödet behöver/],
] as const) {
  test(`a note across a wide card keeps a reading measure: ${state} at ${width} px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const { STATES } = await import("./screens");
    await STATES.find((s) => s.name === state)!.go(page, info);
    const paragraph = page.getByRole("main").locator("p").filter({ hasText: words }).first();
    await expect(paragraph).toBeVisible();
    expect(await measure(paragraph), "the paragraph's width in ch (data-measure is 55)").toBeLessThanOrEqual(56);
  });
}

// A phone on its side (844 x 390, 932 x 430): a run's card stands beside the flow, as the recording's stage does, so its
// heading starts at the page's top and what it offers is in the first screen, not under a stacked flow column.
for (const [state, heading, action] of [
  ["run-progress", "Dokumentet skapas", null],
  ["failure", /kunde inte skapas|Körningen/, "Försök igen"],
] as const) {
  for (const [width, height] of [[844, 390], [932, 430]] as const) {
    test(`on a phone on its side (${width} x ${height}) ${state}'s card stands beside the flow, its heading${action ? ` and ${action}` : ""} in the first screen`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      const { STATES } = await import("./screens");
      await STATES.find((s) => s.name === state)!.go(page, info);
      await page.evaluate(() => window.scrollTo(0, 0));
      const title = (await page.getByRole("heading", { level: 1, name: heading }).boundingBox())!;
      const flowName = (await page.getByRole("main").getByText("Nämndmöte till rapport").first().boundingBox())!;
      expect(title.x, "the card beside the flow's column").toBeGreaterThan(flowName.x + flowName.width - 1);
      expect(title.y, "the card's heading at the page's top").toBeLessThan(height / 2);
      if (!action) return;
      const button = (await page.getByRole("button", { name: action }).first().boundingBox())!;
      expect(button.y + button.height, `${action} in the first screen`).toBeLessThanOrEqual(height);
    });
  }
}

// A laptop's first screen holds the setup's action whole: the latest runs stand in the flow's column, under its name, not
// above the working card, where they would push the action off the first screen.
test("on a laptop (1440 x 900) the setup's action is whole on the first screen, and the latest runs stand in the flow's column", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { STATES } = await import("./screens");
  await STATES.find((s) => s.name === "setup")!.go(page, info);
  await page.evaluate(() => window.scrollTo(0, 0));
  const start = (await page.getByRole("button", { name: "Starta strömning" }).boundingBox())!;
  expect(start.y + start.height, "Starta strömning whole on the first screen").toBeLessThanOrEqual(900);
  const latest = (await page.getByRole("region", { name: "Senaste körningar" }).boundingBox())!;
  const card = (await page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" }).boundingBox())!;
  expect(latest.x + latest.width, "in the flow's column, beside the card").toBeLessThanOrEqual(card.x);
  expect(latest.y, "on the first screen").toBeLessThan(900 / 2);
});

// Below a laptop's width the latest runs open the setup, above the choice of way in, two of them on a phone; a short
// screen keeps its first screen for the ways in and lists only the runs waiting for review there.
for (const [width, height] of [[390, 844], [768, 1024], [320, 568], [844, 390]] as const) {
  test(`at ${width} x ${height} the latest runs stand above the choice of way in${height <= 640 ? ", only those waiting for review" : ""}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    const { STATES } = await import("./screens");
    await STATES.find((s) => s.name === "setup")!.go(page, info);
    const latest = page.getByRole("region", { name: "Senaste körningar" });
    if (height <= 640) {
      await expect(latest, "no run waits: the ways in have the first screen").toHaveCount(0);
      await STATES.find((s) => s.name === "setup-review-waiting")!.go(page, info);
      await expect(latest.getByRole("button", { name: /^Granska, / })).toBeVisible();
    } else {
      await expect(latest.getByRole("listitem")).toHaveCount(width < 768 ? 2 : 3);
    }
    const list = (await latest.boundingBox())!;
    const choice = (await page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" }).boundingBox())!;
    expect(list.y + list.height, "above the choice").toBeLessThanOrEqual(choice.y);
    // The first way in is on the first screen, above the docked action where there is one.
    await page.evaluate(() => window.scrollTo(0, 0));
    const dock = page.locator("[data-docked-action]");
    const end = (await dock.count()) ? (await dock.boundingBox())!.y : height;
    const way = (await page.getByRole("radio").first().boundingBox())!;
    expect(way.y + way.height, "the first way in on the first screen").toBeLessThanOrEqual(end);
  });
}
