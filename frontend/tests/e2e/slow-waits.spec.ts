/**
 * A wait that has no answer is not left without words: after 15 seconds the page says it takes longer than usual and
 * offers to try again (and the way back where it is not the flow list itself). Trying again asks afresh, and what it gets
 * is shown. A run whose status cannot be read says that it tries again, from the first failed read.
 */
import { expect, test } from "./gate";
import type { Route } from "@playwright/test";
import { flowSlow, flowsSlow, hold, pastSlowWait, runOpeningSlow, runReconnecting, slowWaitSays } from "./screens";

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

test("a run whose status cannot be read says it tries again, and Försök nu reads it at once", async ({ page }) => {
  const { mend } = await runReconnecting(page);
  mend();
  // The page is already trying again by itself: the button asks for it now.
  await page.getByRole("button", { name: "Försök nu" }).click();
  await expect(page.getByText("Försöker igen. Körningen fortsätter i Eneo.")).toHaveCount(0);
  await pastSlowWait(page);
  await expect(page.getByText("Det tar längre tid än vanligt.")).toHaveCount(0);
});

for (const path of ["/flows", "/"]) {
  test(`the session that is slow to answer on ${path} says so, with no way back, and Försök igen asks again`, async ({ page }) => {
    await page.clock.install();
    const held = await hold(page, "**/api/auth/status");
    const requested = page.waitForRequest("**/api/auth/status");
    await page.goto(path);
    await requested;
    await expect(page.getByRole("status", { name: "Laddar" })).toBeVisible();
    await pastSlowWait(page);
    await slowWaitSays(page);
    await expect(page.getByRole("link", { name: "Alla flöden" })).toHaveCount(0);
    held.letThrough();
    await page.getByRole("button", { name: "Försök igen" }).click();
    await expect(page.getByRole("link", { name: /Nämndmöte till rapport/ })).toBeVisible();
    await expect(page.getByText("Det tar längre tid än vanligt.")).toHaveCount(0);
  });
}

test("after retrying the sign-in check, a late answer to the old question cannot end the new wait", async ({ page }) => {
  await page.clock.install();
  const old: Route[] = [];
  const first = Promise.withResolvers<void>();
  const current = Promise.withResolvers<Route>();
  let retrying = false;
  await page.route("**/api/auth/status", async (route) => {
    if (retrying) current.resolve(route);
    else {
      old.push(route);
      first.resolve();
    }
  });
  await page.goto("/");
  await first.promise;
  await pastSlowWait(page);
  await slowWaitSays(page);
  retrying = true;
  await page.getByRole("button", { name: "Försök igen" }).click();
  const currentRequest = await current.promise;
  const oldResponse = page.waitForResponse("**/api/auth/status");
  await Promise.all(old.map((request) => request.fulfill({ json: { authenticated: false, user: null } })));
  await (await oldResponse).finished();
  await page.clock.runFor(100);
  const login = page.getByRole("button", { name: "Logga in med Eneo" });
  await expect(login).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Försök igen" })).toBeVisible();
  await currentRequest.fulfill({ json: { authenticated: false, user: null } });
  await expect(login).toBeVisible();
});
