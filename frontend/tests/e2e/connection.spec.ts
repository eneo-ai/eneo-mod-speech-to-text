/**
 * What the page says when it cannot reach the module depends on why: a device with no network says "Ingen anslutning", a
 * device with a network whose requests do not get through says that Tal till text does not answer.
 */
import { expect, test } from "./gate";
import ids from "../fixtures/ids.json";
import { run } from "./screens";

test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1440-light", "behaviour, at one width"));

test("a module that does not answer is not called a lost connection, and a lost network is", async ({ page, context, sentinel }) => {
  sentinel.expect(
    { console: /net::ERR_(FAILED|INTERNET_DISCONNECTED).*\/status\//, optional: true },
    { requestFailed: /GET .*\/status\/.*: net::ERR_(FAILED|INTERNET_DISCONNECTED)/, optional: true },
  );
  await page.clock.install();
  await run(page, ids.runs.running);
  await expect(page.getByRole("heading", { name: "Dokumentet skapas" })).toBeVisible();

  // The module goes quiet: the next poll's request fails on a device that has its network.
  await page.route(/\/runs\/[^/]+\/status\//, (route) => route.abort());
  await page.clock.fastForward(2_000);
  await expect(page.getByText("Tal till text svarar inte just nu. Körningen fortsätter i Eneo och visas här när det svarar igen.")).toBeVisible();
  await expect(page.getByText(/Ingen anslutning/)).toHaveCount(0);

  // Then the device loses its network.
  await context.setOffline(true);
  await expect(page.getByText("Ingen anslutning. Körningen fortsätter i Eneo och visas här när anslutningen är tillbaka.")).toBeVisible();
  await expect(page.getByText(/svarar inte just nu/)).toHaveCount(0);
});
