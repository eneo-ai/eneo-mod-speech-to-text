/**
 * What a screen reader is told about the controls that need more than axe
 * checks: names and descriptions as Chromium's own tree gives them, the
 * groups around them, and the page titles.
 */
import { expect, test } from "@playwright/test";
import { axNode } from "./checks";
import { addParticipants, chooseMode, setup } from "./screens";

test("the input modes are named by their title and described by their line", async ({ page }) => {
  await setup(page);
  for (const [id, name, description] of [
    ["satt-stromma", "Strömma", "Se texten medan du pratar."],
    ["satt-spela-in", "Spela in", "Spela in nu och transkribera efteråt."],
    ["satt-ladda-upp", "Ladda upp", "Välj en ljudfil från din enhet."],
  ]) {
    expect(await axNode(page.locator(`#${id}`))).toEqual({ role: "radio", name, description });
  }
  expect(await axNode(page.getByRole("radiogroup"))).toMatchObject({ name: "Hur vill du ge ljudet?" });
});

test("a field is not an unnamed group", async ({ page }) => {
  await setup(page);
  await chooseMode(page, "Spela in");
  await expect(page.locator('[data-slot="field"][role="group"]')).toHaveCount(0);
});

test("the added names are a named list the field points to", async ({ page }) => {
  await setup(page);
  await addParticipants(page, ["Anna Berg", "Erik Lund"]);
  await expect(page.getByRole("list", { name: "Tillagda namn" })).toBeVisible();
  const field = await axNode(page.getByRole("textbox", { name: /^Deltagare/ }));
  expect(field.description).toContain("2 namn tillagda");
});
