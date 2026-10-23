/**
 * A run that waits for review is followed until its pause can be read: Eneo answers 200 with null while the pause is not
 * there yet, and the page asks again. An error (the run is gone, a refused scope, Eneo down) is not "not yet": it is said,
 * and the page stops asking.
 */
import { expect, test } from "./gate";
import ids from "../fixtures/ids.json";
import { run } from "./screens";

test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1440-light", "behaviour, at one width"));

test("a pause that cannot be read is said once, and the page does not ask for it every two seconds for ever", async ({ page, sentinel }) => {
  sentinel.expect({ console: /status of 503.*\/review-checkpoints\/active/ });
  let reads = 0;
  await page.route("**/review-checkpoints/active**", (route) => {
    reads += 1;
    return route.fulfill({ status: 503, json: { code: "internal_error" } });
  });
  await run(page, ids.runs.review, ids.flows.flow2);

  // The run waits for this person's review in Eneo: the page stays the run's, with a way to read it again, and does not
  // fall back to the start page, where "försök igen" would make a second run.
  const heading = page.getByRole("heading", { level: 1, name: "Granskningen kunde inte hämtas" });
  await expect(heading).toBeFocused();
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toHaveCount(0);
  const readsWhenSaid = reads;
  await page.waitForTimeout(5_000);
  expect(reads, "no request after it was said").toBe(readsWhenSaid);
  expect(readsWhenSaid, "asked once").toBe(1);

  await page.unroute("**/review-checkpoints/active**");
  await page.getByRole("button", { name: "Försök igen" }).click();
  await expect(page.getByRole("heading", { name: "Vem är vem?" })).toBeVisible();
});

test("a pause that is not there yet is asked for again until it is", async ({ page }) => {
  let reads = 0;
  await page.route("**/review-checkpoints/active**", (route) => {
    reads += 1;
    return reads < 3 ? route.fulfill({ contentType: "application/json", body: "null" }) : route.fallback();
  });
  await run(page, ids.runs.review, ids.flows.flow2);

  await expect(page.getByRole("heading", { name: "Vem är vem?" })).toBeVisible({ timeout: 15_000 });
  expect(reads).toBeGreaterThanOrEqual(3);
});
