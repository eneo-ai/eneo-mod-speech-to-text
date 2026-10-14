import { expect, test } from "./gate";
import { fileBackedText, isLaptop, result } from "./screens";
import ids from "../fixtures/ids.json";

test("copying or sharing a file-backed preview says that it is only the beginning", async ({ page }, info) => {
  test.skip(!["phone-320-light", "phone-320-dark", "laptop-1440-light", "laptop-1440-dark"].includes(info.project.name), "narrow and wide action bars, in both themes");
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
  await expect(page.getByRole("button", { name: "Kopierat", exact: true })).toBeVisible();
  const copied = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return { html: await (await item.getType("text/html")).text(), plain: await (await item.getType("text/plain")).text() };
  });
  expect(copied.html).toContain("<h2>Protokoll</h2>");
  expect(copied.html).toContain("<strong>höja budgetramen</strong>");
  expect(copied.html).not.toMatch(/class=|style=/);
  expect(copied.plain).toMatch(/^## Protokoll\n\nKommunstyrelsen beslutade att \*\*höja budgetramen\*\*/);
});
