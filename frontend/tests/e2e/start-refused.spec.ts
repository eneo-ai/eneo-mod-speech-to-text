/**
 * Eneo keeps refusing the run request after the file is uploaded. The page is not a dead end: Avbryt goes back to the
 * details with the file still chosen, a recording can be saved as a file meanwhile, and what is sent again is the same
 * request, under the same Idempotency-Key, with no second upload.
 */
import { expect, test } from "./gate";
import { chooseFile, record, setup, stop } from "./screens";
import { declare } from "./sentinel";

test.beforeEach(({}, info) => test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "one laptop and one phone"));

/** The run request is refused (503) while `state.refusing`; every request's key and every upload is counted. */
async function eneoRefusesTheRun(page: import("@playwright/test").Page) {
  declare(page, [{ console: /status of 503.*\/runs\// }]);
  const state = { refusing: true, keys: [] as string[], uploads: 0 };
  await page.route(/\/runtime-files\/?$/, (route) => {
    if (route.request().method() === "POST") state.uploads += 1;
    return route.fallback();
  });
  await page.route(/\/flows\/[^/]+\/runs\/?$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    state.keys.push(route.request().headers()["idempotency-key"] ?? "");
    return state.refusing ? route.fulfill({ status: 503, json: { detail: "unavailable" } }) : route.fallback();
  });
  return state;
}

test("Avbryt while the run is being started goes back to the details with the file still chosen, and sending again is the same request", async ({ page }) => {
  const eneo = await eneoRefusesTheRun(page);
  await setup(page);
  await chooseFile(page);
  await page.getByRole("button", { name: "Skapa dokument" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Startar flödet" })).toBeVisible();
  await expect(page.getByText("Filen är uppladdad. Vi försöker starta flödet igen.")).toBeVisible();
  await page.getByRole("button", { name: "Avbryt" }).click();
  // Back on the details: the file is still the one chosen.
  await expect(page.getByRole("button", { name: "Byt fil" })).toBeVisible();

  eneo.refusing = false;
  await page.getByRole("button", { name: "Skapa dokument" }).click();
  await page.waitForURL(/[?&]run=/);
  expect(eneo.uploads, "the file was uploaded once").toBe(1);
  expect(eneo.keys.length, "refused, then accepted").toBeGreaterThanOrEqual(2);
  expect(new Set(eneo.keys).size, "one request, under one key").toBe(1);
});

test("a recording being started can be saved as a file meanwhile", async ({ page }) => {
  await eneoRefusesTheRun(page);
  await setup(page);
  await record(page, "Spela in");
  await page.waitForTimeout(1_500);
  await stop(page);
  await page.getByRole("button", { name: "Skapa dokument" }).click();
  await expect(page.getByText("Inspelningen är uppladdad. Vi försöker starta flödet igen.")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Spara som fil" }).click();
  await download;
});
