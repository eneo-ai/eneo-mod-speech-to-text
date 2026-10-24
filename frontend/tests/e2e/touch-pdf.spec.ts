/**
 * A PDF saved on an iPhone or an iPad, in Safari's engine on a touch screen: Safari there shows a PDF in the tab it was
 * asked from even when the module sends it to be saved, so it opens in a tab of its own and the page stays where it was
 * (`savingWay`, components/flow/useFileAccess.ts). Playwright's WebKit shows no PDF and saves it as a Mac's Safari does
 * an attachment, so what this proves is the tab asking for the PDF, and the page left as it was.
 */
import { expect, test } from "./gate";
import { result } from "./screens";

test.beforeEach(({}, info) =>
  test.skip(!(info.project.use.browserName === "webkit" && info.project.use.hasTouch), "Safari's engine on a touch screen"),
);

test("Öppna PDF opens the PDF in a tab of its own, says so, and the page stays where it was", async ({ page }) => {
  await result(page);
  // Where the browser has a share sheet that takes the file (Playwright's WebKit on a Mac), Dela on the page keeps it and the
  // note says only where the PDF opens; without one (WebKit on Linux) it also says how to save it from the tab.
  const shares = await page.evaluate(() => typeof navigator.share === "function");
  const note = shares ? "PDF öppnas i en ny flik." : "PDF öppnas i en ny flik. Spara den där med webbläsarens delaknapp.";
  await expect(page.getByText(note, { exact: true })).toBeVisible();
  const at = page.url();
  const saved: string[] = [];
  page.on("download", (download) => void saved.push(download.url()));
  const opening = page.waitForEvent("popup");
  const sent = page.context().waitForEvent("request", (request) => /\/content\?disposition=inline$/.test(request.url()));
  await page.getByRole("link", { name: /^Öppna PDF/ }).tap();
  const tab = await opening;
  expect((await sent).frame().page(), "the tab is sent to the PDF").toBe(tab);
  expect(page.url(), "the page is where it was").toBe(at);
  await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toBeVisible();
  expect(saved, "nothing is saved from the page's own tab").toEqual([]);
});
