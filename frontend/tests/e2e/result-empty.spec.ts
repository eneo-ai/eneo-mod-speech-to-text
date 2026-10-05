/**
 * A run that finished with nothing to show is not called ready over a blank page: the page says the result is empty and
 * starts a new run with the same audio on request.
 */
import { expect, test } from "./gate";
import { emptyResult } from "./screens";

test.beforeEach(({}, info) =>
  test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "behaviour, at a laptop's and a phone's width"),
);

test("an empty result says so, has no success heading, and Starta en ny körning starts a run", async ({ page }) => {
  await emptyResult(page);
  await expect(page.getByRole("heading", { level: 1, name: "Resultatet är tomt" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /är klar/ })).toHaveCount(0);
  await expect(page.getByText("Körningen blev klar, men flödet gav inget att visa.")).toBeVisible();

  await page.getByRole("button", { name: "Starta en ny körning" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /skapas$/ })).toBeVisible();
});
