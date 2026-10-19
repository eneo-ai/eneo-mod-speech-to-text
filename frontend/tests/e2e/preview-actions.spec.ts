import { expect, test } from "./gate";
import { fileBackedText, isLaptop, result, run } from "./screens";
import ids from "../fixtures/ids.json";

test("a text's more actions stand beside Kopiera texten where they fit, and fold into Fler alternativ where they do not", async ({ page }, info) => {
  test.skip(info.project.name !== "tablet-portrait", "an iPad held upright, then a phone's width and back");
  await page.addInitScript(() => Object.defineProperty(navigator, "share", { value: async () => undefined, configurable: true }));
  // An 11-inch iPad held upright: the width the actions were folded at with room to spare.
  await page.setViewportSize({ width: 834, height: 1194 });
  await run(page, ids.runs.plain);
  await expect(page.getByRole("heading", { name: "Texten är klar" })).toBeVisible();
  const copy = page.getByRole("button", { name: "Kopiera texten", exact: true });
  const save = page.getByRole("button", { name: /^Ladda ner .*\.txt$/ });
  const share = page.getByRole("button", { name: "Dela", exact: true });
  const more = page.getByRole("button", { name: "Fler alternativ" });
  const inOneRow = async () => {
    const tops = await Promise.all([copy, save, share].map(async (button) => Math.round((await button.boundingBox())!.y)));
    return new Set(tops).size === 1;
  };

  await expect(share).toBeVisible();
  await expect(save).toBeVisible();
  await expect(more).toHaveCount(0);
  expect(await inOneRow(), "Kopiera texten, Ladda ner and Dela in one row").toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(more, "a phone's width has no room for them").toBeVisible();
  await expect(share).toHaveCount(0);
  await expect(save).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "and the page does not get wider for them").toBeLessThanOrEqual(390);

  await page.setViewportSize({ width: 834, height: 1194 });
  await expect(share, "back in the row once there is room").toBeVisible();
  await expect(more).toHaveCount(0);
});

test("copying or sharing a file-backed preview says that it is only the beginning", async ({ page }, info) => {
  test.skip(!["phone-320-light", "phone-390-dark", "laptop-1440-light", "laptop-1440-dark"].includes(info.project.name), "narrow and wide action bars, in both themes");
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { document.body.dataset.copiedText = text; } } });
    Object.defineProperty(navigator, "share", { value: async (data: ShareData) => { document.body.dataset.sharedText = data.text; } });
    Object.defineProperty(navigator, "canShare", { value: () => false });
  });
  const answer = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/runs/${ids.runs.fileText}/`) && response.request().method() === "GET");
  await fileBackedText(page);
  const preview: string = (await (await answer).json()).result.preview;
  if (isLaptop(info)) {
    await page.getByRole("button", { name: "Kopiera början", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Fler alternativ" }).click();
    await page.getByRole("menuitem", { name: "Kopiera början", exact: true }).click();
    await page.getByRole("button", { name: "Fler alternativ" }).click();
    await page.getByRole("menuitem", { name: "Dela början", exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute("data-shared-text", preview);
  }
  await expect(page.locator("body")).toHaveAttribute("data-copied-text", preview);
  await expect(page.getByRole("link", { name: "Ladda ner textfilen, Resultat.txt", exact: true })).toBeVisible();
});

test("the document stands still while its file is read for Dela", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390-light", "a phone, where the actions stand above the document and Dela takes a row of its own");
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", { value: async () => undefined });
    Object.defineProperty(navigator, "canShare", { value: () => true });
  });
  // The read for Dela asks for the file at its download address; it waits here for as long as a large file on a slow line would.
  let finishRead!: () => void;
  const reading = new Promise<void>((resolve) => (finishRead = resolve));
  await page.route(/\/artifacts\/[^/]+\/content\?disposition=attachment/, async (route) => {
    await reading;
    await route.fallback();
  });
  await result(page);
  const share = page.getByRole("button", { name: "Dela", exact: true });
  const top = async () => (await page.getByRole("region", { name: "Dokumentet" }).boundingBox())?.y;
  await expect(share, "Dela has its place before the file is read").toBeDisabled();
  const before = await top();
  finishRead();
  await expect(share, "and can be pressed once it is").toBeEnabled();
  expect(await top(), "the document is where it was").toBe(before);
});

test("a copied text keeps its headings and bold where it is pasted, and is the text as written where only text is taken", async ({ page, context }, info) => {
  test.skip(info.project.name !== "laptop-1440-light", "Chromium's own clipboard, read back by the page");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await fileBackedText(page);
  await page.getByRole("button", { name: "Kopiera början", exact: true }).click();
  // The button keeps its words; the copy is said to a screen reader.
  await expect(page.locator('[data-astryx-live-region="polite"]')).toHaveText("Kopierat");
  await expect(page.getByRole("button", { name: "Kopiera början", exact: true })).toBeVisible();
  const copied = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return { html: await (await item.getType("text/html")).text(), plain: await (await item.getType("text/plain")).text() };
  });
  expect(copied.html).toContain("<h2>Protokoll</h2>");
  expect(copied.html).toContain("<strong>höja budgetramen</strong>");
  expect(copied.html).not.toMatch(/class=|style=/);
  expect(copied.plain).toMatch(/^## Protokoll\n\nKommunstyrelsen beslutade att \*\*höja budgetramen\*\*/);
});

test("the PDF dialog says the file is coming while the browser's viewer loads it, and not once it is drawn", async ({ page }, info) => {
  test.skip(info.project.name !== "laptop-1440-light", "the PDF opens in a dialog with a mouse on a laptop");
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/artifacts/**", async (route) => {
    if (route.request().resourceType() === "document") await held;
    return route.fallback();
  });
  await result(page);
  await page.getByRole("button", { name: /^Öppna Protokoll .*\.pdf$/ }).click();
  const dialog = page.getByRole("dialog");
  const loading = dialog.getByRole("status", { name: "Laddar filen" }).or(dialog.getByLabel("Laddar filen"));
  await expect(loading).toBeVisible();
  release();
  await expect(loading).toHaveCount(0);
  await expect(dialog.locator("iframe")).toBeVisible();
});
