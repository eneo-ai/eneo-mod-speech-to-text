/**
 * The answer to the docked Skapa dokument is brought into view above the dock. A phone's network can drop while the page
 * answers, and the offline notice that appears above the answer moves it down: a smooth scroll runs to the offset it
 * computed when it started and leaves the answer under the dock, where a scroll that has ended is kept in place by the
 * browser (scroll anchoring).
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./gate";
import ids from "../fixtures/ids.json";
import { addStyles } from "./checks";
import { chooseFile, setup } from "./screens";

/** Skapa dokument on a flow that Eneo says was republished: the answer appears above the docked action. */
async function answerAboveTheDock(page: Page) {
  await setup(page, ids.flows.flow3);
  await chooseFile(page);
  await page.getByRole("textbox", { name: "Ärende" }).fill("Samråd om detaljplan");
  await page.getByRole("button", { name: "Skapa dokument" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Flödet har uppdaterats" });
  await expect(alert).toBeVisible();
  return alert;
}

// The narrowest phone: the page has to scroll to bring the answer above the dock.
test("the answer brought above the docked action is still above it when the offline notice appears over it as the page scrolls to it", async ({ page, sentinel }, info) => {
  test.skip(info.project.name !== "phone-320-light", "the page scrolls to the answer");
  sentinel.expect({ console: /status of 409.*\/runs\// });
  // The connection drops a moment after the page starts to bring the answer into view.
  await page.addInitScript(() => {
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...args) {
      setTimeout(() => window.dispatchEvent(new Event("offline")), 100);
      return scrollIntoView.apply(this, args);
    };
  });
  await answerAboveTheDock(page);
  await expect(page.getByRole("status").filter({ hasText: "Ingen anslutning." })).toBeAttached();
  // Settled: the scroll has ended, and the notice is in.
  await page.waitForTimeout(1_000);
  const covered = await page.evaluate(() => {
    const answer = [...document.querySelectorAll('[role="alert"]')].find((element) => element.textContent?.includes("Flödet har uppdaterats"))!;
    return Math.round(answer.getBoundingClientRect().bottom - document.querySelector("[data-docked-action]")!.getBoundingClientRect().top);
  });
  expect(covered, "px of the answer under the docked action").toBeLessThanOrEqual(0);
});

/**
 * A notice that arrives late (the network drops while the answer is on screen) moves nothing that is on screen: at the
 * page's top, where the browser anchors no scroll, and without scroll anchoring at all, as in Safari.
 */
for (const anchoring of [true, false]) {
  test(`a late offline notice leaves the answer where it is${anchoring ? "" : ", without the browser's scroll anchoring"}`, async ({ page, sentinel }, info) => {
    test.skip(!["phone-320-light", "phone-390-light"].includes(info.project.name), "a phone, where the action docks");
    sentinel.expect({ console: /status of 409.*\/runs\// });
    const alert = await answerAboveTheDock(page);
    if (!anchoring) await addStyles(page, "html { overflow-anchor: none; }");
    await page.waitForTimeout(500);
    const top = async () => Math.round((await alert.boundingBox())!.y);
    const before = await top();
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.getByRole("status").filter({ hasText: "Ingen anslutning." })).toBeAttached();
    await page.waitForTimeout(300);
    expect(await top(), "the answer's place in the window, before and after the notice").toBe(before);
    const covered = await page.evaluate(() => {
      const answer = [...document.querySelectorAll('[role="alert"]')].find((element) => element.textContent?.includes("Flödet har uppdaterats"))!;
      return Math.round(answer.getBoundingClientRect().bottom - document.querySelector("[data-docked-action]")!.getBoundingClientRect().top);
    });
    expect(covered, "px of the answer under the docked action").toBeLessThanOrEqual(0);
  });
}
