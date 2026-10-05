/**
 * A result's text as the design system's Markdown draws it, at every width: nothing in it is cut off (a table's header
 * cell is one line with an ellipsis unless the theme says otherwise), and a long word or address wraps inside the column.
 */
import { expect, test } from "./gate";
import { STATES } from "./screens";

test("a table's cells are whole at every width, and the prose may break anywhere inside its column", async ({ page }, info) => {
  await STATES.find((s) => s.name === "result-table")!.go(page, info);
  const article = page.getByRole("article").filter({ has: page.getByRole("table") });
  const cut = await article.evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>("th, td")]
      .filter((cell) => cell.scrollWidth > cell.clientWidth + 1 || getComputedStyle(cell).textOverflow === "ellipsis")
      .map((cell) => cell.textContent),
  );
  expect(cut, "cells whose words are cut off").toEqual([]);
  expect(await article.locator('[role="document"]').evaluate((prose) => getComputedStyle(prose).overflowWrap)).toBe("anywhere");
});
