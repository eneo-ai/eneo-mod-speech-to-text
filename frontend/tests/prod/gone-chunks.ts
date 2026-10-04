import type { Page } from "@playwright/test";

// What the stale-chunk specs share: a deploy that deleted files, and a page that must not reload by itself.

/**
 * Refuses the files of one chunk the way a deploy that deleted them is answered: by the backend, as a file it does not
 * have. `name` is the chunk's name in the build (`dist/assets/<name>-<hash>.js`).
 */
export async function removeChunk(page: Page, name: string) {
  const files = new RegExp(`/assets/${name}-[^/]+\\.js$`);
  const refused: string[] = [];
  await page.route(files, (route) => {
    refused.push(new URL(route.request().url()).pathname);
    return route.continue({ url: new URL("/assets/gone-with-the-deploy.js", route.request().url()).href });
  });
  return { refused, lift: () => page.unroute(files) };
}

/**
 * Every script of the build that the page has not fetched by now is refused the same way: the page keeps working on what
 * it has, as a tab does that was opened before the deploy. The files the page fetched are the page's resource timing.
 */
export async function removeChunksNotFetched(page: Page) {
  const fetched = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => new URL(entry.name).pathname)
      .filter((path) => /^\/assets\/[^/]+\.js$/.test(path)),
  );
  const refused: string[] = [];
  await page.route(/\/assets\/[^/]+\.js$/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (fetched.includes(path)) return route.fallback();
    refused.push(path);
    return route.continue({ url: new URL("/assets/gone-with-the-deploy.js", route.request().url()).href });
  });
  return { fetched, refused };
}

/** A mark in this tab's memory and a count of its navigations: a reload clears the first and adds to the second. */
export async function watchForReloads(page: Page) {
  let navigations = 0;
  page.on("framenavigated", (frame) => frame === page.mainFrame() && navigations++);
  await page.evaluate(() => ((window as unknown as { tabBeforeReload: boolean }).tabBeforeReload = true));
  return {
    /** Waits long enough for a reload that nothing asked for to have happened, and says whether the tab is the same one. */
    async stillTheSameTab() {
      const before = navigations;
      await page.waitForTimeout(1500);
      const mark = await page.evaluate(() => (window as unknown as { tabBeforeReload?: boolean }).tabBeforeReload === true);
      return mark && navigations === before;
    },
  };
}
