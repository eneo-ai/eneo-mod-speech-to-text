/**
 * A finished run from a laptop's width: the document and the transcript side by side, the document the wider (7 to 6)
 * under the page's heading, the transcript beside both from the page's top, and the transcript keeping to the window
 * while the document scrolls past it. Below that width they are tabs (result-tabs.spec.ts).
 */
import { type Locator } from "@playwright/test";
import { expect, test } from "./gate";
import { isLaptop, result, STATES } from "./screens";

test.beforeEach(({}, info) => test.skip(!isLaptop(info), "tabs below a laptop's width"));

test("the document is the wider column, the transcript sits beside it and the heading from the page's top and keeps to the window", async ({ page }) => {
  await result(page);
  const columns = await page.evaluate(() => {
    const box = (id: string) => {
      const section = document.getElementById(id)!;
      const rect = section.getBoundingClientRect();
      return { left: rect.left, width: rect.width, top: rect.top, position: getComputedStyle(section).position };
    };
    // The heading's row: the result's tile, then the heading.
    const heading = document.querySelector("h1")!.parentElement!.getBoundingClientRect();
    return { document: box("result-panel-document"), transcript: box("result-panel-transcript"), heading: { left: heading.left, top: heading.top } };
  });
  const { document: doc, transcript, heading } = columns;
  expect(doc.left, "the document is on the left").toBeLessThan(transcript.left);
  expect(Math.round(heading.left), "under the heading").toBe(Math.round(doc.left));
  expect(Math.round(doc.top), "under the heading").toBeGreaterThan(Math.round(heading.top));
  expect(Math.round(transcript.top), "the transcript from the page's top, beside the heading").toBe(Math.round(heading.top));
  expect(doc.width / transcript.width, "the document is a little wider: 7 to 6").toBeGreaterThan(1.1);
  expect(doc.width / transcript.width).toBeLessThan(1.25);
  expect(transcript.position, "the transcript keeps in view while the document scrolls past it").toBe("sticky");
  expect(doc.position).toBe("static");
});

test("scrolled past a long document, the transcript stays at the top of the window", async ({ page }) => {
  await result(page);
  // A document much longer than the window, as a long report is.
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "2400px";
    document.getElementById("result-panel-document")!.append(spacer);
  });
  await page.evaluate(() => window.scrollTo(0, 900));
  const top = await page.evaluate(() => Math.round(document.getElementById("result-panel-transcript")!.getBoundingClientRect().top));
  expect(top, "kept 24 px under the window's top edge").toBe(24);
});

test("on a wide screen the result's workspace grows with the window, the bar with it, and its text keeps a reading measure", async ({ page }, info) => {
  test.skip(info.project.name !== "laptop-1440-light", "the window's size is set here");
  await page.setViewportSize({ width: 2560, height: 1440 });
  await result(page);
  const brand = (await page.getByRole("banner").getByRole("img").first().boundingBox())!;
  // The heading's row (the result's tile, then the heading) starts under the brand.
  const title = (await page.getByRole("heading", { level: 1 }).locator("..").boundingBox())!;
  expect(Math.round(title.x), "the page's heading under the brand").toBe(Math.round(brand.x));
  const transcript = (await page.locator("#result-panel-transcript").boundingBox())!;
  expect(transcript.width, "the transcript beside the document has room").toBeGreaterThanOrEqual(700);
  await expectReadingMeasure(page.locator("#result-panel-document article"));
});

test("a result without a transcript is as wide as the page's column, its text at a reading measure", async ({ page }, info) => {
  test.skip(info.project.name !== "laptop-1440-light", "the window's size is set here");
  // An iPad on its side.
  await page.setViewportSize({ width: 1180, height: 820 });
  await STATES.find((state) => state.name === "result-without-transcript")!.go(page, info);
  const card = (await page.getByRole("region", { name: /^Texten/ }).boundingBox())!;
  const brand = (await page.getByRole("banner").getByRole("img").first().boundingBox())!;
  // The page's column is centred: it ends as far from the window's right edge as the brand starts from its left.
  expect(Math.round(card.x), "from the column's start").toBe(Math.round(brand.x));
  expect(Math.round(card.x + card.width), "to its end").toBe(1180 - Math.round(brand.x));
  await expectReadingMeasure(page.locator("article"));
});

test("the PDF preview uses a wide screen and stays inside a laptop's window", async ({ page }, info) => {
  test.skip(info.project.name !== "laptop-1440-light", "the window's sizes are set here");
  for (const [width, height] of [[1280, 720], [2560, 1440], [3840, 2160]]) {
    await page.setViewportSize({ width, height });
    await result(page);
    await page.getByRole("button", { name: /^Öppna Protokoll .*\.pdf$/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("transform", "none");
    const box = (await dialog.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(Math.min(width * 0.9, 1400) - 1);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    await page.getByRole("button", { name: "Stäng", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
});

/**
 * The text's first paragraph (a block of prose with a measure of its own, not a heading) is as wide as the measure lets
 * it be, the column being wider here: a line of it holds 72 to 80 characters, counted in "0"s of its own font, as CSS's
 * `ch` is.
 */
async function expectReadingMeasure(article: Locator) {
  const [width, least, most] = await article.first().evaluate((text) => {
    const element = [...text.querySelectorAll("*")].find(
      (block) => getComputedStyle(block).maxWidth.endsWith("px") && !block.matches("h1, h2, h3, h4, h5, h6") && block.textContent?.trim(),
    )!;
    const characters = (count: number) => {
      const probe = document.createElement("span");
      probe.textContent = "0".repeat(count);
      probe.style.whiteSpace = "nowrap";
      element.append(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    };
    return [element.getBoundingClientRect().width, characters(72), characters(80)];
  });
  expect(width, "a line of the text holds 72 to 80 characters").toBeGreaterThanOrEqual(least);
  expect(width).toBeLessThanOrEqual(most);
}

test("on a failed run, Gå till transkriberingen brings the transcript's heading to the window's top", async ({ page }, info) => {
  await STATES.find((state) => state.name === "failure")!.go(page, info);
  await page.getByRole("link", { name: "Gå till transkriberingen" }).click();
  const heading = page.locator("#run-transcript");
  await expect(heading).toBeFocused();
  // At the window's top, or as near it as the page's end lets it come. The transcript is last on the page, so in a window
  // taller than what follows its heading (2560 x 1440: the page scrolls 216 px) the page is then at its end, the whole
  // transcript in view under its heading. Focus alone would leave the heading at the window's foot, or not scroll at all.
  const at = await heading.evaluate((element) => ({
    top: element.getBoundingClientRect().top,
    end: scrollY >= document.scrollingElement!.scrollHeight - innerHeight - 1,
    bottom: element.closest('[aria-labelledby="run-transcript"]')!.getBoundingClientRect().bottom,
    height: innerHeight,
  }));
  expect(at.top, "not under the window's top edge").toBeGreaterThanOrEqual(0);
  if (at.top > 1) {
    expect(at.end, "below the window's top only where the page ends").toBe(true);
    expect(at.bottom, "and the transcript under its heading in view").toBeLessThanOrEqual(at.height);
  }
});
