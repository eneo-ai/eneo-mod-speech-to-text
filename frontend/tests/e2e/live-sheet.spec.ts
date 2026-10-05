/**
 * Strömma's live text is read while it arrives, so its sheet is a stage of the window's height, however long the text
 * grows: the sheet scrolls inside itself above the recording bar that stays docked below it, follows the newest line
 * while the reader is at the end, and "Visa senaste" brings it back after a scroll up. A stage that grows with its text
 * pushes the newest line out of the window and the bar's controls with it, which only a long text shows.
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./gate";
import { longLiveText, WORDS } from "./live-relay";
import { record, setup } from "./screens";

// The narrow windows are where the stage is the page's own height; one laptop is the control.
test.beforeEach(({}, info) =>
  test.skip(!["phone-320-light", "phone-390-light", "zoom-200", "laptop-1440-light"].includes(info.project.name), "the narrow windows, and a laptop as the control"),
);

const geometry = (page: Page) =>
  page.evaluate(() => {
    const log = document.querySelector<HTMLElement>('[role="log"]')!;
    const stop = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Stoppa")!;
    const [l, s] = [log.getBoundingClientRect(), stop.getBoundingClientRect()];
    return {
      words: (log.textContent ?? "").split(/\s+/).filter(Boolean).length,
      logBottom: Math.round(l.bottom),
      logHeight: Math.round(l.height),
      stopTop: Math.round(s.top),
      viewport: innerHeight,
      scrolls: log.scrollHeight > log.clientHeight + 2,
      fromEnd: Math.round(log.scrollHeight - log.clientHeight - log.scrollTop),
    };
  });

test("long live text scrolls inside its sheet above the recording bar, follows the newest line, and Visa senaste brings it back", async ({ page }) => {
  await longLiveText(page);
  await setup(page);
  await record(page, "Strömma");
  await expect.poll(async () => (await geometry(page)).words, { timeout: 30_000 }).toBeGreaterThanOrEqual(WORDS - 5);

  const long = await geometry(page);
  expect(long.logHeight, `the sheet is shorter than the window (${JSON.stringify(long)})`).toBeLessThan(long.viewport);
  expect(long.logBottom, `the sheet ends above the bar's controls (${JSON.stringify(long)})`).toBeLessThanOrEqual(long.stopTop + 1);
  expect(long.scrolls, "the text scrolls inside the sheet").toBe(true);
  expect(long.fromEnd, "the newest line is in view").toBeLessThan(4);

  // Scrolled up by hand: the sheet stops following and says how to come back.
  await page.getByRole("log", { name: "Preliminär text" }).evaluate((log) => void (log.scrollTop = 0));
  const latest = page.getByRole("button", { name: "Visa senaste" });
  await expect(latest).toBeVisible();
  await latest.click();
  await expect.poll(async () => (await geometry(page)).fromEnd, { message: "Visa senaste shows the newest line" }).toBeLessThan(4);
  await expect(latest).toBeHidden();
});

test("with the flow's details unfolded the page is taller than the window: the region scrolls to the bar, whose controls are then in reach", async ({ page }, info) => {
  test.skip(!["phone-320-light", "phone-390-light"].includes(info.project.name), "the stacked layout: a phone or tablet");
  await longLiveText(page);
  await setup(page);
  await record(page, "Strömma");
  await expect(page.getByRole("log", { name: "Preliminär text" })).toContainText("oktober", { timeout: 30_000 });
  await page.getByRole("button", { name: /^Uppgifter/ }).click();
  // Scrolled to the end of the region, as a person does to reach what the open details pushed down.
  await page.evaluate(() => {
    const main = document.getElementById("astryx-app-shell-main")!;
    main.scrollTop = main.scrollHeight;
  });
  await page.waitForTimeout(300);
  const reach = await page.evaluate(() => {
    const stop = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Stoppa")!;
    const r = stop.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const main = document.getElementById("astryx-app-shell-main")!;
    return { inside: r.top >= 0 && r.bottom <= innerHeight + 0.5, reached: top === stop || stop.contains(top) || !!top?.contains(stop), scrolled: main.scrollTop, log: Math.round(document.querySelector('[role="log"]')!.getBoundingClientRect().height) };
  });
  expect(reach.inside && reach.reached, `Stoppa is in the window and not covered (${JSON.stringify(reach)})`).toBe(true);
  expect(reach.log, "the text is still a text to read").toBeGreaterThanOrEqual(60);
});
