/**
 * The first frames of the built app, as the backend serves it: the colour mode they are in and the organisation's mark they
 * show. Every frame the browser paints is sampled from the start of the navigation (`requestAnimationFrame`, reading what
 * `getComputedStyle` says of the page, not of a component that may not exist yet).
 *
 * The page's own code is held back until the test has seen frames without it, so what colours those frames is the page
 * the backend sent: `index.html`, its stylesheets and `color-mode.js` (CSS cannot read the stored choice; the script can,
 * and it is a parser-blocking file of the page's own origin, so no frame is painted before it has run). The last
 * test of the colour-mode group blocks that script to show the check above it can fail. In Vite's dev mode the page's CSS
 * arrives through JavaScript, so none of this is provable there (`tests/e2e/color-mode.spec.ts` is the dev profile's).
 */
import { expect, test, type Page } from "@playwright/test";

type Mode = "dark" | "light";
type Stored = Mode | "system" | null;
type Frame = {
  /** The colour mode the page's background is in: a page the stylesheet has not styled is `unstyled`. */
  mode: Mode | "unstyled";
  /** The app has drawn something in `#root`. */
  app: boolean;
  /** `data-brand-logo` of each mark that is on show (a logo made for the other mode is `display: none`). */
  marks: string[];
};
type Painted = { frames: Frame[] };

/** Runs before any script of the page, in every frame of the navigation. */
function sampleFrames() {
  const painted: Painted = ((window as unknown as { painted: Painted }).painted = { frames: [] });
  const modeOf = (colour: string): Frame["mode"] => {
    const [r, g, b, alpha = 1] = (colour.match(/[\d.]+/g) ?? []).map(Number);
    if (alpha === 0) return "unstyled";
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5 ? "dark" : "light";
  };
  const sample = () => {
    const marks = [...document.querySelectorAll("[data-brand-logo]")].filter((mark) => getComputedStyle(mark).display !== "none");
    painted.frames.push({
      mode: modeOf(getComputedStyle(document.body ?? document.documentElement).backgroundColor),
      app: !!document.getElementById("root")?.firstElementChild,
      marks: marks.map((mark) => mark.getAttribute("data-brand-logo") ?? ""),
    });
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

const framesSoFar = (page: Page) => page.evaluate(() => (window as unknown as { painted: Painted }).painted.frames);
const countFrames = (page: Page, which: "all" | "before the app") =>
  page.waitForFunction(
    ([want, kind]) => {
      const frames = (window as unknown as { painted: Painted }).painted.frames;
      return (kind === "all" ? frames : frames.filter((frame) => !frame.app)).length >= want;
    },
    [30, which] as const,
  );

const ENTRY = /\/assets\/index-[^/]*\.js$/;
const SCRIPT = /\/assets\/color-mode\.[^/]*\.js$/;

/**
 * Opens the sign-in page and returns every frame painted until it is there: the first ones with the app's own code held
 * back (a deploy's slow bundle, a slow connection), then the app drawing itself. `colorModeScript` says what happens to
 * the page's first-paint script: it arrives late, or never.
 */
async function paintedFrames(
  page: Page,
  { stored, system, colorModeScript }: { stored: Stored; system: Mode; colorModeScript?: { delayMs: number } | "blocked" },
): Promise<Frame[]> {
  await page.emulateMedia({ colorScheme: system });
  await page.addInitScript(sampleFrames);
  await page.addInitScript((choice) => (choice ? localStorage.setItem("theme", choice) : localStorage.removeItem("theme")), stored);
  if (colorModeScript === "blocked") await page.route(SCRIPT, (route) => route.abort());
  else if (colorModeScript) {
    await page.route(SCRIPT, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, colorModeScript.delayMs));
      await route.continue();
    });
  }
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let holding = false;
  await page.route(ENTRY, async (route) => {
    holding = true;
    await held;
    await route.continue();
  });

  // The navigation is committed, not finished: the held bundle is part of it.
  await page.goto("/", { waitUntil: "commit" });
  await countFrames(page, "before the app");
  expect(holding, "the app's bundle was held, so these frames are the page's own").toBe(true);
  release();
  await expect(page.getByRole("button", { name: "Logga in med Eneo" })).toBeVisible();
  await countFrames(page, "all");
  const frames = await framesSoFar(page);
  // Firefox runs its frame callbacks while it holds back its first paint for the head's stylesheet (a few frames, seen in
  // every run): a callback that finds the page unstyled is not a frame the person saw. Chromium and WebKit run them with a
  // paint, so there an unstyled frame is one, and fails the modes below.
  const holdsBackFirstPaint = page.context().browser()?.browserType().name() === "firefox";
  return holdsBackFirstPaint ? frames.slice(frames.findIndex((frame) => frame.mode !== "unstyled")) : frames;
}

const modesOf = (frames: Frame[]) => [...new Set(frames.map((frame) => frame.mode))];

// What the page paints for each stored choice on each system: the choice when it is light or dark, the system's own mode for
// "system" and for no choice.
for (const [stored, system, expected] of [
  ["dark", "light", "dark"],
  ["light", "dark", "light"],
  ["system", "dark", "dark"],
  [null, "light", "light"],
] as const) {
  test(`stored ${stored ?? "nothing"}, system ${system}: no frame is in the other mode, before the app's code has arrived or after`, async ({ page }) => {
    const frames = await paintedFrames(page, { stored, system });

    expect(frames.some((frame) => !frame.app), "frames were painted before the app drew anything").toBe(true);
    expect(frames.some((frame) => frame.app), "and after").toBe(true);
    expect(modesOf(frames)).toEqual([expected]);
  });
}

test("a first-paint script that arrives late holds the first frame back: no frame is painted before it has run", async ({ page }) => {
  const frames = await paintedFrames(page, { stored: "dark", system: "light", colorModeScript: { delayMs: 1500 } });

  expect(modesOf(frames)).toEqual(["dark"]);
});

// The proof that the tests above can fail: the same page, the same stored choice, with the one file that applies it refused.
test("without the first-paint script the frames before the app are the system's mode, and the sampler sees it", async ({ page }) => {
  const frames = await paintedFrames(page, { stored: "dark", system: "light", colorModeScript: "blocked" });

  const beforeTheApp = frames.filter((frame) => !frame.app);
  expect(modesOf(beforeTheApp), "the stored dark choice is not applied until the app's code is there").toEqual(["light"]);
  expect(modesOf(frames.filter((frame) => frame.app)), "and the app then applies it").toEqual(["dark"]);
});

test("with scripts blocked the page says so in Swedish and is in the system's mode", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false, colorScheme: "dark", locale: "sv-SE" });
  const page = await context.newPage();
  await page.goto("/");

  // Playwright's text locators skip <noscript>, whose content is shown only to a browser that has no scripts.
  const notice = await page.locator("noscript").evaluate((element) => ({ text: element.textContent, shown: getComputedStyle(element).display !== "none" }));
  expect(notice).toEqual({ text: "Tal till text kräver JavaScript. Aktivera det i webbläsaren och ladda om sidan.", shown: true });
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background, "dark, from the stylesheet and the system alone").toBe("rgb(17, 17, 18)");
  await context.close();
});

// The organisation's mark is in the page the backend sent (the marker, backend/app/web.py), so the first frame the app draws
// has it: no frame shows the product alone, another organisation's mark or a logo made for the other mode.
test("the first frame the app draws has the organisation's mark, and nothing asks for the organisation", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));

  const frames = await paintedFrames(page, { stored: null, system: "light" });

  const drawn = frames.filter((frame) => frame.app);
  expect(drawn.length).toBeGreaterThan(0);
  for (const frame of drawn) expect(frame.marks, "the bundled mark of the default organisation").toEqual(["default"]);
  expect(requests.filter((path) => /^\/api\/branding\/?$/.test(path)), "it was in the page").toEqual([]);
});

for (const [stored, system, shown] of [
  [null, "light", "light"],
  ["dark", "light", "dark"],
  ["light", "dark", "light"],
  [null, "dark", "dark"],
] as const) {
  test(`the deployment's own logo in the first frame: stored ${stored ?? "nothing"}, system ${system}, the ${shown} one @branded`, async ({ page }) => {
    const frames = await paintedFrames(page, { stored, system });

    const drawn = frames.filter((frame) => frame.app);
    expect(drawn.length).toBeGreaterThan(0);
    for (const frame of drawn) expect(frame.marks).toEqual([shown]);
  });
}
