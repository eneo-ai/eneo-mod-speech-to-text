/**
 * The deployment's accent stylesheet in the built app, on the backend started as a green deployment (the `branded`
 * project of playwright.prod.config.ts; the others are built for the default blue). It is a plain same-origin
 * stylesheet link, so the strict `style-src 'self'` of the backend lets it in.
 */
import { expect } from "@playwright/test";
import { test } from "../e2e/auth";

// The wide logos the branded backend is started with (tests/fixtures/brand-wide-*.svg: viewBox 0 0 600 48).
const LOGO_SIZE = { width: "600", height: "48" };

test("the accent applies in the built app, under the backend's own strict style policy, with nothing blocked @branded", async ({ session, page }) => {
  expect(session.user).toBeTruthy();
  const problems: string[] = [];
  page.on("console", (message) => message.type() === "error" && problems.push(message.text()));
  await page.goto("/flows");
  await expect(page.getByRole("heading", { name: "Välj ett flöde" })).toBeVisible();
  const accent = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.setProperty("background", "var(--color-accent)");
    document.querySelector('[data-astryx-theme="eneo"]')!.append(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  });
  expect(accent).toBe("rgb(30, 123, 52)");
  expect(problems.filter((text) => /theme\.css|branding/.test(text))).toEqual([]);
});

// Its headers (nosniff, cache, ETag) are the backend's, and its unit tests'.
test("the backend serves the deployment's stylesheet @branded", async ({ request }) => {
  const response = await request.get("/api/branding/theme.css");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/css");
  expect(await response.text()).toContain("--color-accent: light-dark(#1E7B34");
});

test("the organisation is already in the page when the first frame is drawn, and the page asks for no branding @branded", async ({ page, request }) => {
  const requests: string[] = [];
  page.on("request", (message) => requests.push(new URL(message.url()).pathname));
  // The moment the app first puts anything on the page: what it draws then is the first frame the person sees.
  await page.addInitScript(() => {
    (window as unknown as { firstFrame: unknown }).firstFrame = null;
    const watch = new MutationObserver(() => {
      const root = document.getElementById("root");
      if (!root?.firstElementChild) return;
      (window as unknown as { firstFrame: unknown }).firstFrame = [...document.querySelectorAll("img[data-brand-logo]")].map((image) => image.getAttribute("src"));
      watch.disconnect();
    });
    watch.observe(document, { childList: true, subtree: true });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Logga in med Eneo" })).toBeVisible();

  expect(await page.evaluate(() => (window as unknown as { firstFrame: unknown }).firstFrame), "the logos are in the first frame").toEqual([
    "/api/branding/logo/light",
    "/api/branding/logo/dark",
  ]);
  for (const image of await page.locator("img[data-brand-logo]").all()) {
    expect({ width: await image.getAttribute("width"), height: await image.getAttribute("height") }).toEqual(LOGO_SIZE);
  }
  expect(requests.filter((path) => /^\/api\/branding\/?$/.test(path)), "no request for the organisation: it was in the page").toEqual([]);
  // The page the backend sent holds it, in the marker, and nothing else tells the page who it is for.
  const marker = (await (await request.get("/")).text()).match(/<meta name="eneo-branding" content="([^"]*)">/);
  expect(JSON.parse(marker![1].replace(/&quot;/g, '"')).organization).toMatchObject({ logo: "custom", dark_logo: true, logo_sizes: { light: { width: 600, height: 48 } } });
});

test("the mark does not move when its logo arrives @branded", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/branding/logo/**", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const name = page.getByRole("navigation", { name: "Tal till text" }).getByText("Tal till text", { exact: true });
  const logo = page.locator("img[data-brand-logo]:visible");
  await expect(name).toBeVisible();
  await expect(logo, "the logo has room of its own before its file arrives").toHaveCount(1);
  const before = { name: await name.boundingBox(), logo: await logo.boundingBox() };

  release();
  await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), "the logo arrives").toBe(true);
  const after = { name: await name.boundingBox(), logo: await logo.boundingBox() };
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(after.name?.[key], `the name's ${key}`).toBeCloseTo(before.name![key], 1);
    expect(after.logo?.[key], `the logo's ${key}`).toBeCloseTo(before.logo![key], 1);
  }
});
