/**
 * The browser asks about the microphone and the question is never answered: the start does not wait for ever without a
 * word. After a moment the page says where the question is, and Avbryt stops waiting, so the person can start again or
 * choose Ladda upp.
 */
import { expect, test } from "./gate";
import { chooseMode, setup } from "./screens";

test.beforeEach(({}, info) => test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "one laptop and one phone"));

test("an unanswered microphone question is pointed out after a moment, and Avbryt stops waiting for it", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
  });
  await setup(page);
  await chooseMode(page, "Spela in");
  await page.getByRole("button", { name: "Starta inspelning" }).click();
  await expect(page.getByRole("button", { name: "Startar…" })).toBeVisible();
  await expect(page.locator('p[aria-hidden="true"]').filter({ hasText: "Svara på frågan i webbläsaren." })).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: "Avbryt" }).click();
  await expect(page.getByRole("button", { name: "Starta inspelning" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Starta inspelning" })).toBeFocused();
  await expect(page.getByText("Svara på frågan i webbläsaren.")).toHaveCount(0);
});
