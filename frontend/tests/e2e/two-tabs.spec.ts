/**
 * A recording that is stopped and shown in one tab belongs to that tab: another tab does not offer it for sending or
 * deleting, until the first lets it go (it closes, or the recording is sent or deleted).
 */
import { expect, test } from "./gate";
import { record, setup, stop } from "./screens";

test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1440-light", "storage and locks, at one width"));

test("a stopped recording open in one tab is not offered in another, and is when the first tab goes", async ({ page, context }) => {
  await setup(page);
  await record(page, "Spela in");
  await page.waitForTimeout(1_500);
  await stop(page);

  const other = await context.newPage();
  await other.goto("/flows");
  await expect(other.getByRole("heading", { name: "Välj ett flöde" })).toBeVisible();
  await expect(other.getByRole("link", { name: /Nämndmöte till rapport/ })).toBeVisible();
  await expect(other.getByRole("heading", { name: /inspelning(ar)? har inte skickats/ }), "it is on the first tab's screen").toHaveCount(0);

  await page.close({ runBeforeUnload: false });
  // The lock ends with the tab: the recording is the other tab's to send or delete.
  await expect(async () => {
    await other.reload();
    await expect(other.getByRole("heading", { name: "En inspelning har inte skickats" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
});
