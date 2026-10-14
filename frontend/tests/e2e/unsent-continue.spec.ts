/**
 * Fortsätt spela in on a recording a closed tab cut off, in the flow list: the flow's page records on in the same
 * recording, as its own Fortsätt spela in does, without showing the choice of audio on the way.
 */
import { expect, test } from "./gate";
import ids from "../fixtures/ids.json";
import { backLink, record, setup, stop } from "./screens";

test.beforeEach(({}, info) => test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "one laptop and one phone"));

test("from the flow list, Fortsätt spela in records on in the cut-off recording, in its flow", async ({ page, context }) => {
  await setup(page);
  await record(page, "Spela in");
  await page.waitForTimeout(2_500); // a chunk on the device
  await page.close({ runBeforeUnload: false }); // the tab is gone mid-meeting

  const tab = await context.newPage();
  // The lock ends with the tab that held it, soon after it closes.
  await expect(async () => {
    await tab.goto("/flows");
    await expect(tab.getByRole("heading", { name: "Inspelningen avbröts" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await tab.evaluate(() => {
    const seen = new Set<string>();
    (window as unknown as { seen: Set<string> }).seen = seen;
    new MutationObserver(() => {
      for (const heading of document.querySelectorAll("h1, h2")) seen.add(heading.textContent?.trim() ?? "");
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await tab.getByRole("button", { name: "Fortsätt spela in" }).click();
  await expect(tab.getByRole("button", { name: "Stoppa" })).toBeVisible();
  expect(new URL(tab.url()).pathname).toBe(`/flows/${ids.flows.flow1}`);
  expect(new URL(tab.url()).search, "the address no longer asks for it").toBe("");
  const seen = await tab.evaluate(() => [...(window as unknown as { seen: Set<string> }).seen]);
  expect(seen.filter((title) => /Hur vill du lägga till ljudet/.test(title)), `the headings that showed on the way: ${seen.join(" | ")}`).toEqual([]);

  await tab.waitForTimeout(800); // Pausa and Stoppa ignore a press in their first moment
  await stop(tab);
  await backLink(tab).click();
  await tab.getByRole("alertdialog", { name: "Lämna sidan?" }).getByRole("button", { name: "Lämna sidan" }).click();
  await expect(tab.getByRole("heading", { name: "En inspelning har inte skickats" }), "one recording: the meeting went on in it").toBeVisible();
});
