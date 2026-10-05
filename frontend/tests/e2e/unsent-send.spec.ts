/**
 * Skapa dokument on a recording left on the device, in the flow list: the page goes from the list to the upload as one
 * transition. The flow's own screens (the choice of audio, the finished recording) are not shown on the way.
 */
import { expect, test } from "./gate";
import { leaveRecording } from "./screens";

test.beforeEach(({}, info) => test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "one laptop and one phone"));

test("from the unsent list, Skapa dokument shows no screen of the flow before the upload", async ({ page }) => {
  await leaveRecording(page);
  await page.evaluate(() => {
    const seen = new Set<string>();
    (window as unknown as { seen: Set<string> }).seen = seen;
    new MutationObserver(() => {
      for (const heading of document.querySelectorAll("h1, h2")) seen.add(heading.textContent?.trim() ?? "");
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await page.getByRole("button", { name: "Skapa dokument" }).click();
  // The run has started: its address names it.
  await page.waitForURL(/[?&]run=/);
  const seen = await page.evaluate(() => [...(window as unknown as { seen: Set<string> }).seen]);
  expect(seen.filter((title) => /Hur vill du lägga till ljudet|Inspelningen är klar|^Ladda upp$/.test(title)), `the headings that showed on the way: ${seen.join(" | ")}`).toEqual([]);
});
