/**
 * A form sent twice is two runs, and a press again after a lost answer is the run Eneo already made: against a fixture
 * that does what Eneo does with Idempotency-Key (it keeps each accepted run start and answers the same key with the same
 * run). The stub makes a new run for every request, so the fixture is a route in front of it here.
 */
import type { Page } from "@playwright/test";
import ids from "../fixtures/ids.json";
import { expect, test } from "./gate";
import { chooseMode, setup } from "./screens";
import { declare } from "./sentinel";

test.beforeEach(({}, info) =>
  test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "one laptop and one phone"),
);

const FLOW = ids.flows.flow1;

/** The flow's file made optional, so its form goes alone, and Eneo's memory of run starts by key. */
async function eneoWithKeys(page: Page) {
  const accepted = new Map<string, string>();
  // While set, every answer to a run start is lost on its way back: Eneo has the run, the page never hears.
  const lose = { answers: false };
  await page.route(new RegExp(`/api/eneo/flows/${FLOW}/run-contract/`), async (route) => {
    const response = await route.fetch();
    const contract = await response.json();
    contract.steps_requiring_input = contract.steps_requiring_input.map((step: object) => ({ ...step, required: false }));
    await route.fulfill({ response, json: contract });
  });
  await page.route(new RegExp(`/api/eneo/flows/${FLOW}/runs/$`), async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const key = route.request().headers()["idempotency-key"];
    let body = accepted.get(key);
    if (body === undefined) {
      const response = await route.fetch();
      body = await response.text();
      accepted.set(key, body);
    }
    if (lose.answers) return route.abort("failed");
    return route.fulfill({ status: 201, contentType: "application/json", body });
  });
  return { accepted, lose };
}

async function sendForm(page: Page) {
  await chooseMode(page, "Ladda upp");
  await page.getByRole("button", { name: "Skapa dokument" }).click();
}

const runInAddress = (page: Page) => new URL(page.url()).searchParams.get("run");

test("the same form sent twice is two runs", async ({ page }) => {
  const eneo = await eneoWithKeys(page);
  await setup(page, FLOW);
  await sendForm(page);
  await page.waitForURL(/[?&]run=/);
  const first = runInAddress(page);

  await setup(page, FLOW);
  await sendForm(page);
  await page.waitForURL(/[?&]run=/);
  expect(eneo.accepted.size, "Eneo accepted two run starts").toBe(2);
  expect(runInAddress(page)).not.toBe(first);
});

test("a press again after a lost answer and a reload gets the run Eneo made", async ({ page }) => {
  declare(page, [{ console: /net::ERR_FAILED/ }, { requestFailed: /POST .*\/runs\/.*net::ERR_FAILED/ }]);
  const eneo = await eneoWithKeys(page);
  await setup(page, FLOW);
  eneo.lose.answers = true;
  await sendForm(page);
  // Eneo has the run; the page never heard, and waits to ask again. The person reloads instead, and presses again.
  await expect.poll(() => eneo.accepted.size).toBe(1);
  await setup(page, FLOW); // the reload: the page that waited, and its retries, are gone
  eneo.lose.answers = false;
  await sendForm(page);
  await page.waitForURL(/[?&]run=/);
  expect(eneo.accepted.size, "one run start, answered twice").toBe(1);
  expect(runInAddress(page)).toBe(JSON.parse([...eneo.accepted.values()][0]).id);
});
