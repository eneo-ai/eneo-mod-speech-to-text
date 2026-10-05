/**
 * The answer to the docked Skapa dokument is brought into view above the dock. A phone's network can drop while the page
 * answers, and the offline notice that appears above the answer moves it down: a smooth scroll runs to the offset it
 * computed when it started and leaves the answer under the dock, where a scroll that has ended is kept in place by the
 * browser (scroll anchoring).
 */
import { expect, test } from "./gate";
import ids from "../fixtures/ids.json";
import { chooseFile, setup } from "./screens";

// The narrowest phone: the page has to scroll to bring the answer above the dock. On a taller one it is in view without a
// scroll, and a notice that arrives above it later moves it down with nothing to anchor the scroll to.
test.beforeEach(({}, info) => test.skip(info.project.name !== "phone-320-light", "the page scrolls to the answer"));

test("the answer brought above the docked action is still above it when the offline notice appears over it as the page scrolls to it", async ({ page, sentinel }) => {
  sentinel.expect({ console: /status of 409.*\/runs\// });
  // The connection drops a moment after the page starts to bring the answer into view.
  await page.addInitScript(() => {
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...args) {
      setTimeout(() => window.dispatchEvent(new Event("offline")), 100);
      return scrollIntoView.apply(this, args);
    };
  });
  await setup(page, ids.flows.flow3);
  await chooseFile(page);
  await page.getByRole("textbox", { name: "Ärende" }).fill("Samråd om detaljplan");
  await page.getByRole("button", { name: "Skapa dokument" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Flödet har uppdaterats" });
  await expect(alert).toBeVisible();
  await expect(page.getByText("Ingen anslutning.")).toBeVisible();
  // Settled: the scroll has ended, and the notice is in.
  await page.waitForTimeout(1_000);
  const covered = await page.evaluate(() => {
    const answer = [...document.querySelectorAll('[role="alert"]')].find((element) => element.textContent?.includes("Flödet har uppdaterats"))!;
    return Math.round(answer.getBoundingClientRect().bottom - document.querySelector("[data-docked-action]")!.getBoundingClientRect().top);
  });
  expect(covered, "px of the answer under the docked action").toBeLessThanOrEqual(0);
});
