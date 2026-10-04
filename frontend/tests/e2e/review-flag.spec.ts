/**
 * The review page with the speaker review switched on (NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED, fixed when the app is built),
 * where the speakers sit in a card that folds away: `npm run test:a11y:review`, which starts the app that way. Only there
 * are these tests run; the gate's own app has the setting off.
 */
import { expect, test } from "@playwright/test";
import { run } from "./screens";

test.skip(process.env.NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED !== "true", "needs the app started with the speaker review on");

test("names typed but not saved come back as a dialog you can see and reach", async ({ page }) => {
  await run(page, "run-review", "flow-2");
  await page.getByRole("button", { name: /^Talare/ }).first().click();
  await page.getByRole("button", { name: "Namnge talarna" }).click();
  const dialog = page.getByRole("dialog", { name: "Namnge talarna" });
  await dialog.getByRole("combobox", { name: "Vem är Talare 2?" }).fill("Karin Holm");
  await dialog.getByRole("button", { name: "Stäng", exact: true }).click();
  await expect(dialog).toBeHidden();

  // Reloaded, the card is folded again and the dialog opens by itself with what was typed.
  await page.reload();
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box?.width, "the dialog has a width").toBeGreaterThan(200);
  expect(box?.height, "the dialog has a height").toBeGreaterThan(200);
  await expect(dialog.getByRole("combobox", { name: "Vem är Talare 2?" })).toHaveValue("Karin Holm");
  // Focus is inside it, so a keyboard and a screen reader are in the dialog and not on the page behind it.
  expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
  // A phone has no Escape: Stäng takes it away.
  await dialog.getByRole("button", { name: "Stäng", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("the editor's code that cannot be fetched leaves the transcript with a way to try again, and one press fetches only that code", async ({ page }) => {
  // The editor's chunk is the script that holds its own words. It is refused, as to a tab that is older than the deploy
  // that replaced its files (the dev server's StrictMode asks twice), until the test lets it through.
  let refusing = true;
  let refused = 0;
  let served = 0;
  await page.route(/\/_next\/static\/chunks\/.*\.js(\?|$)/, async (route) => {
    const response = await route.fetch();
    if (!(await response.text()).includes("Nästa passage som behöver talarbeslut")) return route.fulfill({ response });
    if (refusing) {
      refused += 1;
      return route.abort();
    }
    served += 1;
    return route.fulfill({ response });
  });
  await run(page, "run-review", "flow-2");
  const problem = page.getByText("Granskningsverktygen kunde inte läsas in.");
  await expect(problem).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Transkript, markera ord för att redigera" })).toHaveCount(0);
  expect(refused, "the editor's code was asked for").toBeGreaterThan(0);

  // The page holds what its reader has not saved: it is not reloaded, only the editor's code is fetched again.
  await page.evaluate(() => ((window as unknown as { kept: boolean }).kept = true));
  refusing = false;
  await page.getByRole("button", { name: "Försök igen" }).click();
  await expect(page.getByRole("textbox", { name: "Transkript, markera ord för att redigera" })).toBeVisible();
  await expect(problem).toHaveCount(0);
  expect(served, "one fetch of the editor's code, by the press").toBe(1);
  expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept), "the page was not reloaded").toBe(true);
});
