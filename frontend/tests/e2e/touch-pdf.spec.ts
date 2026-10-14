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

test("Ladda ner PDF opens the PDF in a tab of its own, and the page stays where it was", async ({ page }) => {
  await result(page);
  const at = page.url();
  const saved: string[] = [];
  page.on("download", (download) => void saved.push(download.url()));
  const opening = page.waitForEvent("popup");
  const sent = page.context().waitForEvent("request", (request) => /\/content\?disposition=inline$/.test(request.url()));
  await page.getByRole("link", { name: /^Ladda ner PDF/ }).tap();
  const tab = await opening;
  expect((await sent).frame().page(), "the tab is sent to the PDF").toBe(tab);
  expect(page.url(), "the page is where it was").toBe(at);
  await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toBeVisible();
  expect(saved, "nothing is saved from the page's own tab").toEqual([]);
});
