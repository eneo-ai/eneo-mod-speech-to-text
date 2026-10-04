/**
 * The deployment's accent stylesheet in the built app, on the backend started as a green deployment (the `branded`
 * project of playwright.prod.config.ts; the others are built for the default blue). It is a plain same-origin
 * stylesheet link, so the strict `style-src 'self'` of the backend lets it in.
 */
import { expect } from "@playwright/test";
import { test } from "../e2e/auth";

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
