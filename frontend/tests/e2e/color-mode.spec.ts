/**
 * The stored colour mode is the page's from its first paint, on the design system's components as on the old ones:
 * next-themes sets the class on <html> before the page shows, and the theme root follows it (app/globals.css).
 */
import { expect, test } from "@playwright/test";

test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1440-light", "one width is enough"));

type Sampled = { modes: string[] };

for (const [stored, system] of [["dark", "light"], ["light", "dark"], ["system", "dark"], [null, "light"]] as const) {
  test(`stored ${stored ?? "nothing"}, system ${system}: no frame in the other mode`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: system });
    const page = await context.newPage();
    await page.addInitScript((stored) => {
      if (stored) localStorage.setItem("theme", stored);
      else localStorage.removeItem("theme");
      const modes: string[] = ((window as unknown as Sampled).modes = []);
      const dark = (color: string) => {
        const [r, g, b] = (color.match(/[\d.]+/g) ?? []).map(Number);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
      };
      let frames = 0;
      const sample = () => {
        // A card's surface is light in the light mode and dark in the dark one.
        const surface = document.querySelector(".astryx-card");
        if (surface) modes.push(dark(getComputedStyle(surface).backgroundColor) ? "dark" : "light");
        if (++frames < 240) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, stored);
    await page.goto(`${baseURL}/dev/foundation`);
    await expect(page.getByRole("heading", { name: "Grundkontroll" })).toBeVisible();
    await page.waitForFunction(() => (window as unknown as Sampled).modes.length >= 60);
    const seen = await page.evaluate(() => [...new Set((window as unknown as Sampled).modes)]);
    expect(seen).toEqual([stored === "dark" || stored === "light" ? stored : system]);
    await context.close();
  });
}
