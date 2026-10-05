import { expect, type Page } from "@playwright/test";
import { test } from "../e2e/auth";
import ids from "../fixtures/ids.json";

// Every address of the app is the page, a missing file or API path is a 404 that is not a page, and the development pages
// are in no default build. The backend's routing (backend/app/web.py) and the app's route table, met in a browser.
const TITLE = " · Tal till text";

test("a direct visit to a route of the app renders that page, in Swedish", async ({ session, page }) => {
  expect(session.user).toBeTruthy();
  const visits: [string, string | RegExp][] = [
    ["/flows", `Välj ett flöde${TITLE}`],
    [`/flows/${ids.flows.flow1}?run=${ids.runs.done}`, /Tal till text$/],
    ["/inloggad", `Inloggad igen${TITLE}`],
    ["/inloggad?fel=utgangen", `Inloggningen har gått ut${TITLE}`],
    ["/inloggad?fel=annan-anvandare", `Fel användare${TITLE}`],
  ];

  for (const [path, title] of visits) {
    // Settled before the next visit: leaving the result page while its audio requests are still going can leave
    // Firefox's next page without a load event for good (the visits below it are the page's own, not a test of that).
    const response = await page.goto(path, { waitUntil: "networkidle" });

    expect(response?.status(), path).toBe(200);
    await expect(page, path).toHaveTitle(title);
    await expect(page.locator("html"), path).toHaveAttribute("lang", "sv");
    expect(new URL(page.url()).pathname, "no redirect for a route of the app").toBe(new URL(path, "http://x").pathname);
  }
});

/** The path the app has gone to: the route table's catch-all replaces the address once the page's code is there. */
const goesTo = (page: Page, path: string) => expect.poll(() => new URL(page.url()).pathname, { message: path }).toBe("/");

test("an address that is no route of the app goes to the start, and the API's own pages are not there", async ({ page, request }) => {
  await page.goto("/docs");
  await goesTo(page, "/docs");

  const openapi = await request.get("/openapi.json");
  expect(openapi.status()).toBe(404);
  expect(openapi.headers()["content-type"]).toContain("application/json");
});

test("a development page is in no default build", async ({ page }) => {
  for (const path of ["/dev/foundation", "/dev/speaker-review"]) {
    await page.goto(path);

    await goesTo(page, path);
  }
});

test("the development pages are in the check build @fixture", async ({ page }) => {
  await page.goto("/dev/foundation");
  await expect(page.getByRole("heading", { name: "Grundkontroll" })).toBeVisible();
  await page.goto("/dev/speaker-review");

  expect(new URL(page.url()).pathname).toBe("/dev/speaker-review");
});

test("a missing file or API path is a 404 that is not a page, and HEAD is answered like GET", async ({ request }) => {
  for (const path of ["/assets/missing.js", "/missing.png", "/api/nope", "/api"]) {
    const response = await request.get(path);

    expect(response.status(), path).toBe(404);
    expect(response.headers()["content-type"] ?? "", path).not.toContain("text/html");
  }
  expect((await request.head("/")).status()).toBe(200);
});
