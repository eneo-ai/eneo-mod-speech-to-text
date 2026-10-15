import { expect, test } from "./gate";
import ids from "../fixtures/ids.json";
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

test("saved corrections that cannot be read leave the document to read, and the transcript says so", async ({ page, sentinel }, info) => {
  test.skip(info.project.name !== "laptop-1440-light", "a request failure at one width");
  sentinel.expect({ console: /status of 503.*\/transcript-corrections\// });
  await page.route("**/transcript-corrections/", (route) =>
    route.request().method() === "GET" ? route.fulfill({ status: 503, json: { code: "upstream_unreachable" } }) : route.fallback(),
  );
  await page.goto(`/flows/${ids.flows.flow1}?run=${ids.runs.corrected}`);
  await expect(page.getByRole("heading", { level: 1, name: "Dokumentet är klart" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Dokument" })).toBeVisible();
  await expect(page.getByText("Kunde inte läsa sparade rättningar.", { exact: false })).toBeVisible();
  // Without the corrections there is nothing to say about them: no notice, no button that cannot act.
  await expect(page.getByText("Dokumentet skapades före dina rättningar")).toHaveCount(0);
});

test("corrections newer than the document that cannot make a new one keep the notice in its place, and it says why there", async ({ page }, info) => {
  test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "a request failure at two widths");
  // Saved for another version of the transcript than the one the run has: newer than the document, but not its own.
  await page.route("**/transcript-corrections/", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const sets = (await (await route.fetch()).json()) as { segments_hash?: string }[];
    return route.fulfill({ json: sets.map((set) => ({ ...set, segments_hash: "b".repeat(64) })) });
  });
  // The transcript's last read is held, so the notice is seen while the corrections are being checked.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/transcript-words/**", async (route) => (await held, route.fallback()));
  await page.goto(`/flows/${ids.flows.flow1}?run=${ids.runs.corrected}`);
  const notice = page.getByRole("note").filter({ hasText: "Dokumentet skapades före dina rättningar" });
  await expect(notice.getByRole("button", { name: "Skapa dokumentet igen med rättningarna" })).toBeDisabled();
  const documentTop = () => page.getByRole("region", { name: "Dokument" }).evaluate((element) => Math.round(element.getBoundingClientRect().top));
  const before = await documentTop();

  release();
  await expect(notice.getByText("Rättningarna kunde inte läsas just nu.")).toBeVisible();
  await expect(notice.getByRole("button", { name: "Läs in igen" })).toBeVisible();
  await expect(notice.getByRole("button", { name: "Skapa dokumentet igen med rättningarna" })).toHaveCount(0);
  expect(await documentTop(), "the document stays where it was drawn").toBe(before);
});
