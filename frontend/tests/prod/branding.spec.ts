/**
 * The deployment's accent stylesheet in the built app: `STUB_BRANDING=custom npm run test:prod -- branding.spec.ts
 * --project=chromium` (the stub is then a green deployment, which the other prod tests, built for the default blue,
 * do not expect). It is a plain same-origin stylesheet link, so a strict style-src 'self' still lets it in.
 */
import { expect, test } from "@playwright/test";

test.beforeEach(() => test.skip(!process.env.STUB_BRANDING, "needs the stub as a deployment with its own accent colour"));

test("the accent applies in the built app, also under a strict style-src 'self', with nothing blocked", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (message) => message.type() === "error" && problems.push(message.text()));
  // The production policy, with its one inline-style allowance taken away.
  await page.route("**/flows", async (route) => {
    const response = await route.fetch();
    const policy = response.headers()["content-security-policy"];
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": policy.replace("style-src 'self' 'unsafe-inline'", "style-src 'self'") } });
  });
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

// Its headers (nosniff, cache, ETag) are the backend's, and its unit tests'; the stub answers here.
test("the built app's /api rewrite delivers the stylesheet", async ({ request }) => {
  const response = await request.get("/api/branding/theme.css");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/css");
  expect(await response.text()).toContain("--color-accent: light-dark(#1E7B34");
});
