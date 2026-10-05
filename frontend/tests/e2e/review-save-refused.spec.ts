import { expect, test } from "./gate";
import ids from "../fixtures/ids.json";
import { run } from "./screens";

test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1440-light", "request failure and keyboard focus at one width"));

for (const action of ["Spara ändring", "Spara och fortsätt"]) {
  test(`a refused ${action} restores focus and keeps the review edit through reload`, async ({ page, sentinel }) => {
    sentinel.expect({ console: /status of 503.*\/review-checkpoints\// });
    let release!: () => void;
    const response = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/review-checkpoints/*/", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      await response;
      return route.fulfill({ status: 503, json: { code: "upstream_unreachable" } });
    });
    await run(page, ids.runs.reviewText);
    await page.getByRole("button", { name: "Redigera", exact: true }).click();
    const field = page.getByRole("textbox", { name: "Innehåll för granskning" });
    await field.fill("Beslutet som Eneo inte kunde spara.");
    const save = page.getByRole("button", { name: action, exact: true });
    await save.click();
    await expect(save).toBeDisabled();
    release();
    await expect(page.getByRole("alert").filter({ hasText: /Eneo gick inte att nå/ })).toBeVisible();
    await expect(save).toBeFocused();
    await expect(field).toHaveValue("Beslutet som Eneo inte kunde spara.");
    await page.reload();
    await expect(field).toHaveValue("Beslutet som Eneo inte kunde spara.");
  });
}
