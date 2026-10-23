/**
 * The app with the speaker review switched on (SPEAKER_REVIEW_ENABLED, fixed when the app is built): the review page,
 * where the speakers sit in a card that folds away, and a finished run's result, whose transcript shows the review's own
 * view. `npm run test:a11y:review` starts the app that way. Only there are these tests run; the gate's own app has the
 * setting off.
 */
import { expect, test } from "./gate";
import { isLaptop, run, startedRun } from "./screens";
import ids from "../fixtures/ids.json";

test.skip(process.env.SPEAKER_REVIEW_ENABLED !== "true", "needs the app started with the speaker review on");

test("names typed but not saved come back as a dialog you can see and reach", async ({ page }) => {
  await run(page, ids.runs.review, ids.flows.flow2);
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

test("a finished run's speakers are named on its result: Namnge talare stands above the review's view, which shows the names at once", async ({ page }, info) => {
  const { id, finish } = await startedRun(page);
  await finish();
  await run(page, id);
  await expect(page.getByRole("heading", { level: 1, name: "Dokumentet är klart" })).toBeVisible();
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();

  const naming = page.getByRole("button", { name: "Namnge talare" });
  await naming.click();
  const dialog = page.getByRole("dialog", { name: "Namnge talarna" });
  for (const [speaker, name] of [["Talare 1", "Anna Berg"], ["Talare 2", "Erik Lund"]]) {
    await dialog.getByRole("combobox", { name: `Vem är ${speaker}?` }).fill(name);
    // Typing opens the name list over what is below the field; a press outside it closes it first.
    await dialog.getByRole("heading", { name: "Namnge talarna" }).click();
  }
  await dialog.getByRole("button", { name: "Spara namnen" }).click();
  await expect(dialog).toBeHidden();
  await expect(naming, "the focus is back where the naming was opened").toBeFocused();

  // Each passage of the review's view says its speaker by the name.
  await expect(page.getByRole("button", { name: "Markera stycket: Anna Berg" })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Markera stycket: Erik Lund" })).toHaveCount(2);
  await expect(page.getByRole("button", { name: /^Markera stycket: Talare/ })).toHaveCount(0);
});

test("the editor's code that cannot be fetched leaves the transcript with the person's own reload, and what was typed is back after it, with the editor", async ({ page }) => {
  // The editor's code is the script that holds its own words, whatever the bundler names it. It is refused, as to a tab
  // that is older than the deploy that replaced its files, until the test lets it through. A browser keeps a failed
  // module fetch per address, so a second import() would make no request: the recovery is a reload, and the person's.
  let refusing = true;
  let refused = 0;
  let served = 0;
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "script") return route.fallback();
    const response = await route.fetch();
    if (!(await response.text()).includes("Nästa passage som behöver talarbeslut")) return route.fulfill({ response });
    if (refusing) {
      refused += 1;
      return route.abort();
    }
    served += 1;
    return route.fulfill({ response });
  });
  await run(page, ids.runs.review, ids.flows.flow2);
  const editor = page.getByRole("textbox", { name: "Transkribering, markera ord för att redigera" });
  const problem = page.getByText("Granskningsverktygen kunde inte läsas in.");
  await expect(problem).toContainText("Det du har skrivit finns kvar.");
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Försök igen" }), "no retry that cannot work").toHaveCount(0);

  // What the reader types meanwhile is a draft: names, kept when the dialog is closed.
  await page.getByRole("button", { name: /^Talare/ }).first().click();
  await page.getByRole("button", { name: "Namnge talarna" }).click();
  const dialog = page.getByRole("dialog", { name: "Namnge talarna" });
  await dialog.getByRole("combobox", { name: "Vem är Talare 2?" }).fill("Karin Holm");
  await dialog.getByRole("button", { name: "Stäng", exact: true }).click();
  await expect(dialog).toBeHidden();

  // Nothing reloads by itself: it is the same page, and the editor's code was not asked for again.
  await page.evaluate(() => ((window as unknown as { samePage: boolean }).samePage = true));
  const asked = refused;
  await page.waitForTimeout(1_000);
  expect(refused, "nothing asked again by itself").toBe(asked);
  expect(await page.evaluate(() => (window as unknown as { samePage?: boolean }).samePage)).toBe(true);

  // The press reloads the page; the code is served now, and the typed names come back with the editor.
  refusing = false;
  await page.getByRole("button", { name: "Ladda om sidan" }).click();
  await expect(dialog.getByRole("combobox", { name: "Vem är Talare 2?" })).toHaveValue("Karin Holm");
  await dialog.getByRole("button", { name: "Stäng", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(problem).toHaveCount(0);
  expect(served, "the editor's code was fetched once, by the new page").toBe(1);
  expect(await page.evaluate(() => (window as unknown as { samePage?: boolean }).samePage), "the page was reloaded").toBeUndefined();
});

test("below a laptop's width, Namnge talare shares the row of the transcript's own actions: no row holds it alone", async ({ page }, info) => {
  test.skip(isLaptop(info), "from a laptop's width the actions stand in the transcript's heading row");
  const { id, finish } = await startedRun(page);
  await finish();
  await run(page, id);
  await expect(page.getByRole("heading", { level: 1, name: "Dokumentet är klart" })).toBeVisible();
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const naming = (await page.getByRole("button", { name: "Namnge talare" }).boundingBox())!;
  const copy = (await page.getByRole("button", { name: /^Kopiera transkriberingen|^Fler alternativ för transkriberingen/ }).first().boundingBox())!;
  expect(Math.abs(naming.y + naming.height / 2 - (copy.y + copy.height / 2)), "one row").toBeLessThanOrEqual(4);
});
