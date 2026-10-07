/** A real page sends several bounded parts and recovers after the server committed a part but its reply was lost. */
import { expect, test } from "./gate";
import { chooseMode, setup, wav } from "./screens";
import { declare } from "./sentinel";

test.beforeEach(({}, info) => test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "one laptop and one phone"));

test("a large file resumes after a lost part reply, then starts one run", async ({ page }) => {
  declare(page, [{ console: /net::ERR_FAILED.*\/api\/uploads\// }, { requestFailed: /PATCH .*\/api\/uploads\/.*net::ERR_FAILED/ }]);
  const offsets: number[] = [];
  const resources = new Set<string>();
  let dropped = false;
  let runs = 0;
  await page.route(/\/api\/uploads\//, async (route) => {
    const request = route.request();
    resources.add(request.url().replace(/\/complete$/, ""));
    if (request.method() !== "PATCH") return route.fallback();
    offsets.push(Number(request.headers()["upload-offset"]));
    if (!dropped) {
      dropped = true;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await response.dispose();
      return route.abort("failed");
    }
    return route.fallback();
  });
  await page.route(/\/flows\/[^/]+\/runs\/$/, (route) => {
    if (route.request().method() === "POST") runs += 1;
    return route.fallback();
  });
  await setup(page);
  await chooseMode(page, "Ladda upp");
  const audio = wav(280); // 4.48 MB: two parts, still below the flow's duration and file limits.
  expect(audio.length).toBeGreaterThan(4 * 1024 * 1024);
  await page.locator('input[type="file"]').setInputFiles({ name: "langt-mote.wav", mimeType: "audio/wav", buffer: audio });
  await expect(page.getByRole("button", { name: "Byt fil" })).toBeVisible();
  await page.getByRole("button", { name: "Skapa dokument" }).click();
  await page.waitForURL(/[?&]run=/);
  expect(offsets).toEqual([0, 4 * 1024 * 1024]);
  expect(resources.size).toBe(1);
  expect(runs).toBe(1);
});
