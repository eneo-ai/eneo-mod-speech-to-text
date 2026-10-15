/**
 * Fortsätt spela in on a recording a closed tab cut off, in the flow list: it stands before the other unsent recordings,
 * which fold away so the flows stay in view, and the flow's page records on in the same recording, as its own Fortsätt
 * spela in does, without showing the choice of audio on the way. While the tab still records it, the list only says so.
 */
import { expect, test } from "./gate";
import ids from "../fixtures/ids.json";
import { backLink, keptRecording, record, setup, stop } from "./screens";

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

test("with three unsent recordings the flow list keeps its flows in view: the one a reload cut off stands first, the rest folded", async ({ page }) => {
  await page.goto("/flows");
  await keptRecording(page, 1_000);
  await keptRecording(page, 1_000, "recording"); // cut off by a reload
  await keptRecording(page, 1_000);
  await page.reload();
  await expect(page.getByRole("heading", { name: "3 inspelningar har inte skickats" })).toBeVisible();
  await expect(page.getByRole("button", { name: "2 inspelningar till" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Fortsätt spela in" }), "the one to go on with, though not the newest").toBeVisible();
  await expect(page.getByRole("link", { name: /^Nämndmöte till rapport/ }).first(), "a flow above the fold").toBeInViewport({ ratio: 1 });
});

test("a recording another tab is recording is told of in the flow list, with nothing to do there until that tab lets it go", async ({ page, context }) => {
  await setup(page);
  await record(page, "Spela in");
  await page.waitForTimeout(2_500); // a chunk on the device
  const other = await context.newPage();
  await other.goto("/flows");
  const region = other.getByRole("region", { name: "En inspelning har inte skickats" });
  await expect(region.getByText("Inspelningen används i en annan flik.")).toBeVisible();
  await expect(region.getByRole("button"), "nothing the recording tab would have to undo").toHaveCount(0);

  await page.close({ runBeforeUnload: false }); // the tab is gone mid-meeting, and its lock soon after
  // Nothing tells the other tab: it reads the list again when it is back in view.
  await expect(async () => {
    await other.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(other.getByRole("button", { name: "Fortsätt spela in" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
});
