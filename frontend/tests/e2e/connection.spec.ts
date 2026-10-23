/**
 * What the page says when it cannot reach the module depends on why: a device with no network says "Ingen anslutning", a
 * device with a network whose requests do not get through says that Tal till text does not answer.
 */
import { expect, test } from "./gate";
import ids from "../fixtures/ids.json";
import { flows, run } from "./screens";

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
  const notice = page.locator('[aria-hidden="true"]');
  await expect(notice.getByText("Tal till text svarar inte just nu. Körningen fortsätter i Eneo och visas här när det svarar igen.", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /^Tal till text svarar inte just nu/ })).toHaveCount(1);
  await expect(page.getByText(/Ingen anslutning/)).toHaveCount(0);

  // Then the device loses its network.
  sentinel.expect(
    { console: /net::ERR_INTERNET_DISCONNECTED.*\/api\/eneo\/flows\/[^/]+\/graph\/\?run_id=[\da-f-]+\]$/, optional: true },
    { requestFailed: /GET .*\/api\/eneo\/flows\/[^/]+\/graph\/\?run_id=[\da-f-]+: net::ERR_INTERNET_DISCONNECTED$/, optional: true },
  );
  await context.setOffline(true);
  await expect(notice.getByText("Ingen anslutning. Körningen fortsätter i Eneo och visas här när anslutningen är tillbaka.", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /^Ingen anslutning/ })).toHaveCount(1);
  await expect(page.getByText(/svarar inte just nu/)).toHaveCount(0);
});

test("an answer that was on its way when the network went does not bring the network back", async ({ page, context, sentinel }) => {
  sentinel.expect(
    { console: /net::ERR_INTERNET_DISCONNECTED/, optional: true },
    { requestFailed: /net::ERR_INTERNET_DISCONNECTED$/, optional: true },
  );
  await page.clock.install();
  await run(page, ids.runs.running);
  await expect(page.getByRole("heading", { name: "Dokumentet skapas" })).toBeVisible();

  // The next poll's answer is fetched and kept: its request left while the device had its network.
  let hand!: () => void;
  const kept = new Promise<void>((resolve) => (hand = resolve));
  let left!: () => void;
  const leaving = new Promise<void>((resolve) => (left = resolve));
  await page.route(/\/runs\/[^/]+\/status\//, async (route) => {
    const response = await route.fetch();
    left();
    await kept;
    await route.fulfill({ response });
  });
  await page.clock.fastForward(2_000);
  await leaving;

  await context.setOffline(true);
  const notice = page.locator('[aria-hidden="true"]').getByText("Ingen anslutning. Körningen fortsätter i Eneo och visas här när anslutningen är tillbaka.", { exact: true });
  await expect(notice).toBeVisible();

  // The kept answer arrives now, after the network went. The page has read it when its response is done.
  const read = page.waitForResponse(/\/runs\/[^/]+\/status\//);
  hand();
  await (await read).finished();
  await page.evaluate(() => new Promise<void>((drawn) => requestAnimationFrame(() => requestAnimationFrame(() => drawn()))));
  await expect(notice, "the page still says the device has no network").toBeVisible();
  await expect(page.getByText(/svarar inte just nu/)).toHaveCount(0);
});

test("the flow list says when the network goes, and a flow opened without one appears by itself when it is back", async ({ page, context, sentinel }) => {
  sentinel.expect({ console: /net::ERR_INTERNET_DISCONNECTED/, optional: true }, { requestFailed: /net::ERR_INTERNET_DISCONNECTED$/, optional: true });
  await flows(page);
  // The list fetches the flow page's code while it is read (routes/FlowsPage.tsx).
  await page.waitForLoadState("networkidle");

  await context.setOffline(true);
  await expect(page.getByRole("status").filter({ hasText: /^Ingen anslutning\.$/ })).toHaveCount(1);

  await page.getByRole("link", { name: /^Nämndmöte till rapport/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Ingen anslutning." })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 }), "the page's heading has the focus the link had").toBeFocused();

  await context.setOffline(false);
  const setup = page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" });
  await expect(setup, "without a press on Försök igen").toBeVisible();
  await expect(setup).toBeFocused();
});
