/**
 * The device fills up while a recording runs: the bar says so and what to do, the recording goes on in the tab, and
 * leaving says it is only there. Once the person has freed room, the next try puts it on the device again, a note says
 * so, and the finished recording is kept on the device.
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./gate";
import { backLink, record, setup, stop } from "./screens";

test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1440-light", "storage, at one width"));

/** A device whose writes of audio fail as a full disk's do while `window.diskFull` is set. */
const fillable = (page: Page) =>
  page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if ((window as unknown as { diskFull?: boolean }).diskFull) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
const diskFull = (page: Page, full: boolean) => page.evaluate((on) => ((window as unknown as { diskFull?: boolean }).diskFull = on), full);

test("a full device is said with what to do, and once there is room the recording is kept on the device again", async ({ page }) => {
  // The page's own clock, so the store's next try of the device comes when the test says.
  await page.clock.install();
  await fillable(page);
  await setup(page);
  await record(page, "Spela in");

  await diskFull(page, true);
  const full = page.getByRole("alert").filter({ hasText: "Enheten är full." });
  await expect(full).toBeVisible({ timeout: 15_000 });
  await expect(full).toContainText("Frigör utrymme, till exempel genom att tömma Hämtade filer och papperskorgen");
  await expect(full).toContainText("Stäng inte fliken.");
  await expect(page.getByRole("button", { name: "Stoppa" }), "the recording goes on").toBeVisible();

  // Leaving says what only the tab has.
  await backLink(page).click();
  const leave = page.getByRole("alertdialog", { name: "Lämna sidan?" });
  await expect(leave).toContainText("finns bara i den här fliken");
  await leave.getByRole("button", { name: "Stanna kvar" }).click();

  await diskFull(page, false); // the person empties Hämtade filer
  await page.clock.fastForward(20_000); // the store's next try
  await expect(page.getByText("Det finns plats igen, och inspelningen sparas på enheten.")).toBeVisible();
  await expect(full).toHaveCount(0);
  await page.clock.fastForward(10_000);
  await expect(page.getByText("Det finns plats igen, och inspelningen sparas på enheten."), "said for a moment").toHaveCount(0);

  await stop(page);
  await expect(page.getByText("finns kvar på enheten tills Eneo har tagit emot den.")).toBeVisible();
});
