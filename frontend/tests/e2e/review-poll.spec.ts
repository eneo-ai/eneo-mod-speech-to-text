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

  await expect(page.getByRole("alert")).toBeVisible();
  const readsWhenSaid = reads;
  await page.waitForTimeout(5_000);
  expect(reads, "no request after it was said").toBe(readsWhenSaid);
  expect(readsWhenSaid, "asked once").toBe(1);
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
