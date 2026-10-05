import { expect, test } from "./gate";
import { STATES } from "./screens";

test("a refused document regeneration shows its reason and keeps focus for another attempt", async ({ page, sentinel }, info) => {
  test.skip(info.project.name !== "laptop-1440-light", "request failure and keyboard focus at one width");
  sentinel.expect({ console: /status of 503.*\/transcript-regenerations\// });
  let release!: () => void;
  const response = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/transcript-regenerations/", async (route) => {
    await response;
    return route.fulfill({ status: 503, json: { code: "upstream_unreachable" } });
  });
  await STATES.find((state) => state.name === "result-regenerate")!.go(page, info);
  const regenerate = page.getByRole("button", { name: /^Skapar? dokumentet igen/ });
  await regenerate.click();
  await expect(regenerate).toBeDisabled();
  release();
  await expect(page.getByRole("alert").filter({ hasText: "Eneo gick inte att nå just nu. Försök igen om en stund." })).toBeVisible();
  await expect(regenerate).toBeEnabled();
  await expect(regenerate).toBeFocused();
});
