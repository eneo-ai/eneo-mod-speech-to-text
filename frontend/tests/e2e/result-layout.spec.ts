/**
 * A finished run from a laptop's width: the document and the transcript side by side, the document the wider (7 to 6),
 * both from the same top, and the transcript keeping to the window while the document scrolls past it. Below that
 * width they are tabs (result-tabs.spec.ts).
 */
import { expect, test } from "./gate";
import { isLaptop, result } from "./screens";

test.beforeEach(({}, info) => test.skip(!isLaptop(info), "tabs below a laptop's width"));

test("the document is the wider column, the transcript sits beside it from the same top and keeps to the window", async ({ page }) => {
  await result(page);
  const columns = await page.evaluate(() => {
    const box = (id: string) => {
      const section = document.getElementById(id)!;
      const rect = section.getBoundingClientRect();
      return { left: rect.left, width: rect.width, top: rect.top, position: getComputedStyle(section).position };
    };
    return { document: box("result-panel-document"), transcript: box("result-panel-transcript") };
  });
  const { document: doc, transcript } = columns;
  expect(doc.left, "the document is on the left").toBeLessThan(transcript.left);
  expect(Math.round(doc.top), "from the same top").toBe(Math.round(transcript.top));
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
