/**
 * A finished run from a laptop's width: the document and the transcript side by side, the document the wider (7 to 6)
 * under the page's heading, the transcript beside both from the page's top, and the transcript keeping to the window
 * while the document scrolls past it. Below that width they are tabs (result-tabs.spec.ts).
 */
import { expect, test } from "./gate";
import { isLaptop, result } from "./screens";

test.beforeEach(({}, info) => test.skip(!isLaptop(info), "tabs below a laptop's width"));

test("the document is the wider column, the transcript sits beside it and the heading from the page's top and keeps to the window", async ({ page }) => {
  await result(page);
  const columns = await page.evaluate(() => {
    const box = (id: string) => {
      const section = document.getElementById(id)!;
      const rect = section.getBoundingClientRect();
      return { left: rect.left, width: rect.width, top: rect.top, position: getComputedStyle(section).position };
    };
    const heading = document.querySelector("h1")!.getBoundingClientRect();
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
