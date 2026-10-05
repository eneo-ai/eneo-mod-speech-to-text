/**
 * A review that is over (it ran out, or was decided elsewhere) is not left on the screen with buttons that fail: the run
 * is read again and the page shows what it is now.
 */
import { expect, test } from "./gate";
import ids from "../fixtures/ids.json";
import { run } from "./screens";

test.beforeEach(({}, info) =>
  test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "behaviour, at a laptop's and a phone's width"),
);

test("a review that ran out as Fortsätt was pressed gives way to the run as it is now, with a way to start it again", async ({ page, sentinel }) => {
  sentinel.expect({ console: /status of 409.*\/resume\// });
  let expired = false;
  await page.route("**/review-checkpoints/*/resume/", (route) => {
    expired = true;
    return route.fulfill({ status: 409, json: { code: "flow_review_expired", detail: "The review has expired." } });
  });
  // Once it has run out, Eneo has cancelled the run.
  const cancelled = (body: object) => ({
    ...body,
    status: "cancelled",
    error: { code: "flow_review_expired", message: "The review expired.", retryable: false },
  });
  for (const url of [`**/runs/${ids.runs.reviewTextApproved}/`, `**/runs/${ids.runs.reviewTextApproved}/status/**`]) {
    await page.route(url, async (route) => {
      const response = await route.fetch();
      return route.fulfill({ response, json: expired ? cancelled(await response.json()) : await response.json() });
    });
  }
  // The run's audio is in Eneo, so a new run can use it (the stub's steps do not say which file went in).
  await page.route(`**/runs/${ids.runs.reviewTextApproved}/steps/`, async (route) => {
    const steps: object[] = await (await route.fetch()).json();
    return route.fulfill({ json: steps.map((step, at) => (at === 0 ? { ...step, runtime_input_file_ids: [ids.files.audioA] } : step)) });
  });
  await run(page, ids.runs.reviewTextApproved);
  await expect(page.getByText("Granskningen är redan godkänd. Välj Fortsätt så går flödet vidare.")).toBeVisible();

  await page.getByRole("button", { name: "Fortsätt", exact: true }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Körningen avbröts" })).toBeVisible();
  await expect(page.getByText(/Tiden för granskningen har gått ut/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Starta en ny körning" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fortsätt", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Avvisa" })).toHaveCount(0);
});
