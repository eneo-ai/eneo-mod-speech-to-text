/**
 * The device fills up for real (Chromium's quota for the origin, through the DevTools protocol): an engine refuses a write
 * of a full origin late, by aborting its transaction, where disk-full.spec.ts throws at once with a clock the test drives.
 * The recording goes on in the tab and the page says so; once there is room it is kept on the device again; and a
 * recording the device stopped keeping is not said to be on the device by the flow list in the same tab.
 */
import { type BrowserContext, type Page } from "@playwright/test";
import { expect, test } from "./gate";
import { backLink, record, setup, stop } from "./screens";

test.beforeEach(({ browserName }, info) => test.skip(info.project.name !== "laptop-1440-light" || browserName !== "chromium", "storage, at one width, in the engine whose quota a test can set"));

/**
 * The origin's quota, set through a DevTools session that is kept for the test (Chromium drops the override when the
 * session goes): a few seconds of audio over what the origin holds, on a page that opens no database (the address no
 * route has), before the recordings' database is opened. `lift` gives the device's own quota back.
 */
async function fillUp(context: BrowserContext, page: Page) {
  await page.goto("/finns-inte");
  const cdp = await context.newCDPSession(page);
  const origin = new URL(page.url()).origin;
  const usage = await page.evaluate(async () => (await navigator.storage.estimate()).usage ?? 0);
  await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: usage + 15_000 });
  return { lift: () => cdp.send("Storage.overrideQuotaForOrigin", { origin }) };
}

test("a device that fills up for real: said while recording, and once there is room the recording is kept on the device", async ({ page, context }) => {
  const device = await fillUp(context, page);
  await setup(page);
  await record(page, "Spela in");
  const full = page.getByRole("alert").filter({ hasText: "Enheten är full." });
  await expect(full).toBeVisible({ timeout: 30_000 });
  await backLink(page).click();
  const leave = page.getByRole("alertdialog", { name: "Lämna sidan?" });
  await expect(leave).toContainText("finns bara i den här fliken");
  await leave.getByRole("button", { name: "Stanna kvar" }).click();

  await device.lift();
  await expect(page.getByText("Det finns plats igen, och inspelningen sparas på enheten.")).toBeVisible({ timeout: 45_000 });
  await stop(page);
  await expect(page.getByText("finns kvar på enheten tills Eneo har tagit emot den.")).toBeVisible();
});

test("a recording the full device stopped keeping is not said to be on the device by the flow list in the same tab", async ({ page, context }) => {
  const device = await fillUp(context, page);
  await setup(page);
  await record(page, "Spela in");
  await expect(page.getByRole("alert").filter({ hasText: "Enheten är full." })).toBeVisible({ timeout: 30_000 });
  await stop(page);

  await backLink(page).click();
  await page.getByRole("alertdialog", { name: "Lämna sidan?" }).getByRole("button", { name: "Lämna sidan" }).click();
  const card = page.getByRole("region", { name: "En inspelning har inte skickats" });
  await expect(card).toContainText("Enheten är full, så det senaste av inspelningen finns bara i den här fliken. Stäng inte fliken.");
  await expect(card).not.toContainText("finns på den här enheten");
  await expect(card).not.toContainText("finns kvar på den här enheten");
  await device.lift();
});
