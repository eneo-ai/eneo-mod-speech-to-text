/** The setup's own wording and fields: what the speaker switch says takes longer, per way of giving the audio, and the calendar's week. */
import { expect, test } from "./gate";
import ids from "../fixtures/ids.json";
import { chooseMode, setup } from "./screens";

// Words, not layout: one width is enough.
test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1440-light", "words, at one width"));

test("the speaker switch says what takes longer after the way the audio was given", async ({ page }) => {
  await setup(page);
  const choice = page.getByRole("switch", { name: "Märk upp talare" });
  await chooseMode(page, "Spela in");
  await expect(choice).toHaveAccessibleDescription("Tar längre tid efter inspelningen.");
  await chooseMode(page, "Ladda upp");
  await expect(choice).toHaveAccessibleDescription("Tar längre tid efter uppladdningen.");
});

test("the calendar's week starts on Monday", async ({ page }) => {
  await setup(page, ids.flows.flow5);
  await page.getByRole("button", { name: "Öppna kalender" }).click();
  const days = await page.getByRole("dialog", { name: "Välj datum" }).getByRole("columnheader").allInnerTexts();
  expect(days.map((day) => day.toLowerCase().slice(0, 2)), `the weekdays as the calendar lists them: ${days}`).toEqual(["må", "ti", "on", "to", "fr", "lö", "sö"]);
});
