/**
 * A wait that has no answer is not left without words: after 15 seconds the page says it takes longer than usual and
 * offers to try again (and the way back where it is not the flow list itself). Trying again asks afresh, and what it gets
 * is shown. A run whose status cannot be read says that it tries again, from the first failed read.
 */
import { expect, test } from "./gate";
import { flowSlow, flowsSlow, pastSlowWait, runOpeningSlow, runReconnecting } from "./screens";

test.beforeEach(({}, info) =>
  test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "behaviour, at a laptop's and a phone's width"),
);

test("a flow that is slow to load says so, and Försök igen loads it", async ({ page }) => {
  const held = await flowSlow(page);
  await expect(page.getByRole("main").getByRole("link", { name: "Alla flöden" })).toBeVisible();
  held.letThrough();
  await page.getByRole("button", { name: "Försök igen" }).click();
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
  await expect(page.getByText("Det tar längre tid än vanligt.")).toHaveCount(0);
});

test("the flow list that is slow to load says so, with no way back to itself, and Försök igen loads it", async ({ page }) => {
  const held = await flowsSlow(page);
  await expect(page.getByRole("main").getByRole("link", { name: "Alla flöden" })).toHaveCount(0);
  held.letThrough();
  await page.getByRole("button", { name: "Försök igen" }).click();
  await expect(page.getByRole("link", { name: /Nämndmöte till rapport/ })).toBeVisible();
  await expect(page.getByText("Det tar längre tid än vanligt.")).toHaveCount(0);
});

test("a run that is slow to open says so, and Försök igen opens it", async ({ page }) => {
  const held = await runOpeningSlow(page);
  held.letThrough();
  await page.getByRole("button", { name: "Försök igen" }).click();
  await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toBeVisible();
});

test("a run whose status cannot be read says it tries again, and Försök igen reads it at once", async ({ page }) => {
  const { mend } = await runReconnecting(page);
  mend();
  await page.getByRole("button", { name: "Försök igen" }).click();
  await expect(page.getByText("Försöker igen. Körningen fortsätter i Eneo.")).toHaveCount(0);
  await pastSlowWait(page);
  await expect(page.getByText("Det tar längre tid än vanligt.")).toHaveCount(0);
});
