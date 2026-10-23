/**
 * A file sent while the device has no network, or one whose network goes in the middle of a part: the page says it waits
 * for the connection, and when the network is back the upload goes on, one run starts and its result is shown. Code the
 * page fetches on the way (the run's steps and views) is not asked for while the device is offline: a browser keeps a
 * failed fetch of a module for the life of the page.
 */
import { expect, test } from "./gate";
import { chooseFile, chooseMode, setup, wav } from "./screens";
import { declare } from "./sentinel";

test.beforeEach(({}, info) => test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "one laptop and one phone"));

const WAITS = "Ingen anslutning. Uppladdningen fortsätter när anslutningen är tillbaka.";

test("a file sent while offline goes when the network is back, and the run's result is shown", async ({ page, context }) => {
  declare(page, [
    { console: /net::ERR_INTERNET_DISCONNECTED/, optional: true },
    { requestFailed: /net::ERR_INTERNET_DISCONNECTED$/, optional: true },
  ]);
  let runs = 0;
  await page.route(/\/flows\/[^/]+\/runs\/$/, (route) => {
    if (route.request().method() === "POST") runs += 1;
    return route.fallback();
  });
  await setup(page);
  await chooseFile(page);
  await context.setOffline(true);
  await page.getByRole("button", { name: "Skapa dokument" }).click();
  await expect(page.getByRole("status").filter({ hasText: WAITS })).toHaveCount(1);

  await context.setOffline(false);
  await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/kunde inte visas/)).toHaveCount(0);
  expect(runs).toBe(1);
});

test("a network that goes in the middle of a part: the page waits for it, and the upload goes on from where the module has it", async ({ page, context }) => {
  declare(page, [
    { console: /net::ERR_INTERNET_DISCONNECTED/, optional: true },
    { requestFailed: /net::ERR_INTERNET_DISCONNECTED$/, optional: true },
  ]);
  const offsets: number[] = [];
  let cut = false;
  let runs = 0;
  await page.route(/\/api\/uploads\//, async (route) => {
    const request = route.request();
    if (request.method() !== "PATCH") return route.fallback();
    offsets.push(Number(request.headers()["upload-offset"]));
    if (!cut) {
      // The device loses its network while the first part is on its way.
      cut = true;
      await context.setOffline(true);
      return route.abort("internetdisconnected");
    }
    return route.fallback();
  });
  await page.route(/\/flows\/[^/]+\/runs\/$/, (route) => {
    if (route.request().method() === "POST") runs += 1;
    return route.fallback();
  });
  await setup(page);
  await chooseMode(page, "Ladda upp");
  await page.locator('input[type="file"]').setInputFiles({ name: "langt-mote.wav", mimeType: "audio/wav", buffer: wav(280) }); // two parts
  await expect(page.getByRole("button", { name: "Byt fil" })).toBeVisible();
  await page.getByRole("button", { name: "Skapa dokument" }).click();
  await expect(page.getByRole("status").filter({ hasText: WAITS })).toHaveCount(1);

  await context.setOffline(false);
  await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toBeVisible({ timeout: 60_000 });
  expect(offsets[0]).toBe(0);
  expect(offsets.at(-1), "the last part is the second").toBe(4 * 1024 * 1024);
  expect(runs).toBe(1);
});
