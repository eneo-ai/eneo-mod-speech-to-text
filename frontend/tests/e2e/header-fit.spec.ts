/**
 * The top bar at the narrowest width with the text spacing WCAG 1.4.12 lets a reader set. The design system's bar
 * never shrinks the brand, so a brand that is too wide runs into the account button beside it: the product's name is
 * then covered, or cut to "Tal till …". They keep a gap's width between them.
 */
import { expect, test } from "./gate";
import { addStyles, TEXT_SPACING } from "./checks";
import { flows } from "./screens";

const GAP = 8;

test("at 320 px with text spacing the brand and the account button keep apart, and the name is whole", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-320-light", "the narrowest width");
  await flows(page);
  await addStyles(page, TEXT_SPACING);
  const brand = page.getByRole("link", { name: /^Tal till text –/ });
  const account = page.getByRole("button", { name: /^Öppna konto för/ });
  const [brandBox, accountBox] = [await brand.boundingBox(), await account.boundingBox()];
  expect(brandBox && accountBox, "both are shown").toBeTruthy();
  expect(accountBox!.x - (brandBox!.x + brandBox!.width), "the room between them").toBeGreaterThanOrEqual(GAP);
  const name = brand.getByText("Tal till text", { exact: true });
  expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth), "the name is not cut off").toBe(true);
});
