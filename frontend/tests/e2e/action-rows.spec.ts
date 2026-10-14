/**
 * A step's decision is one row with one rule (components/ActionRow.tsx, as the design system's alert dialog has it): up to
 * 640 px wide its buttons stack across the whole row, the main one on top and first for the keyboard; wider, they stand
 * in one row at its end, the main one last. An editor's own buttons are no decision: small, at the field's start, right
 * under it, and Spara ändring only while there is a change to save.
 */
import { type Locator } from "@playwright/test";
import ids from "../fixtures/ids.json";
import { expect, test } from "./gate";
import { keptRecording, run } from "./screens";

test.beforeEach(({}, info) => test.skip(!["phone-390-light", "laptop-1440-light"].includes(info.project.name), "a phone and a laptop"));

/** Where the main and the other button stand in the row that holds them, rounded to whole pixels. */
async function layout(main: Locator, other: Locator) {
  await expect(main).toBeVisible();
  return main.evaluate((primary, secondary) => {
    const box = (element: Element) => {
      const { left, right, top, bottom } = element.getBoundingClientRect();
      return { left: Math.round(left), right: Math.round(right), top: Math.round(top), bottom: Math.round(bottom) };
    };
    const row = primary.parentElement!;
    return {
      row: box(row),
      main: box(primary),
      other: box(secondary!),
      oneRow: secondary!.parentElement === row,
      mainFirst: Boolean(primary.compareDocumentPosition(secondary!) & Node.DOCUMENT_POSITION_FOLLOWING),
    };
  }, await other.elementHandle());
}

/** The decision's rule as `layout` finds it: across the row and the main on top when `stacked`, else side by side at its end. */
function followsTheRule(found: Awaited<ReturnType<typeof layout>>, stacked: boolean) {
  const { row, main, other } = found;
  const seen = {
    oneRow: found.oneRow,
    mainFirst: found.mainFirst,
    across: [main, other].every((button) => button.left === row.left && button.right === row.right),
    mainOnTop: main.bottom <= other.top,
    side: main.top === other.top && other.right < main.left,
    atEnd: main.right === row.right,
  };
  expect(seen, JSON.stringify(found)).toEqual(
    stacked
      ? { oneRow: true, mainFirst: true, across: true, mainOnTop: true, side: false, atEnd: true }
      : { oneRow: true, mainFirst: false, across: false, mainOnTop: false, side: true, atEnd: true },
  );
}

const REVIEWS = [
  { name: "who is who", id: ids.runs.review, flow: ids.flows.flow2, heading: "Vem är vem?" },
  { name: "the text review", id: ids.runs.reviewText, flow: ids.flows.flow1, heading: "Sammanfattning" },
];

for (const review of REVIEWS) {
  test(`${review.name}: Avvisa and Godkänn och fortsätt follow the decision's rule`, async ({ page }, info) => {
    await run(page, review.id, review.flow);
    await expect(page.getByRole("heading", { name: review.heading, level: 1 })).toBeVisible();
    const found = await layout(page.getByRole("button", { name: "Godkänn och fortsätt" }), page.getByRole("button", { name: "Avvisa", exact: true }));
    followsTheRule(found, info.project.use.viewport!.width <= 640);
  });
}

test("an unsent recording's actions stack across its card on a phone and stand in one row wider, Ta bort last; its delete question is a decision", async ({ page }, info) => {
  await page.goto("/flows");
  await keptRecording(page, 1_000);
  await page.reload();
  const card = page.getByRole("region", { name: "En inspelning har inte skickats" }).getByRole("listitem");
  const actions = card.getByRole("button");
  await expect(actions).toHaveText(["Skapa dokument", "Spara som fil", "Ta bort"]);
  const boxes = await actions.evaluateAll((buttons) =>
    buttons.map((button) => {
      const { left, right, top } = button.getBoundingClientRect();
      return { left: Math.round(left), right: Math.round(right), top: Math.round(top) };
    }),
  );
  const stacked = info.project.use.viewport!.width <= 640;
  const seen = {
    oneEdge: boxes.every((box) => box.left === boxes[0].left && box.right === boxes[0].right),
    oneRow: boxes.every((box) => box.top === boxes[0].top),
    inOrder: boxes.every((box, i) => i === 0 || (stacked ? box.top > boxes[i - 1].top : box.left > boxes[i - 1].right)),
  };
  expect(seen, JSON.stringify(boxes)).toEqual(
    stacked ? { oneEdge: true, oneRow: false, inOrder: true } : { oneEdge: false, oneRow: true, inOrder: true },
  );

  await card.getByRole("button", { name: "Ta bort" }).click();
  followsTheRule(await layout(card.getByRole("button", { name: "Ta bort" }), card.getByRole("button", { name: "Avbryt" })), stacked);
});

test("the text review's editor: its buttons stand small at the field's start, Spara ändring only with a change", async ({ page }) => {
  await run(page, ids.runs.reviewText);
  await page.getByRole("button", { name: "Redigera" }).click();
  const field = page.getByRole("textbox", { name: "Innehåll för granskning" });
  const cancel = page.getByRole("button", { name: "Avbryt", exact: true });
  const save = page.getByRole("button", { name: "Spara ändring" });
  await expect(cancel).toBeVisible();
  await expect(save, "nothing to save yet").toHaveCount(0);
  await field.fill("Kommunstyrelsen beslutade att höja budgetramen med tre procent.");
  await expect(save).toBeVisible();
  const [fieldBox, cancelBox, saveBox] = await Promise.all([field, cancel, save].map((element) => element.boundingBox()));
  const gap = Math.round(cancelBox!.y - (fieldBox!.y + fieldBox!.height));
  expect(
    {
      // The text box sits inside the field's one-pixel border.
      atTheFieldsStart: Math.abs(cancelBox!.x - fieldBox!.x) <= 1,
      underTheField: gap >= 0 && gap <= 16,
      saveBeside: Math.round(saveBox!.y) === Math.round(cancelBox!.y) && saveBox!.x > cancelBox!.x + cancelBox!.width,
    },
    JSON.stringify({ field: fieldBox, cancel: cancelBox, save: saveBox }),
  ).toEqual({ atTheFieldsStart: true, underTheField: true, saveBeside: true });
  await expect(cancel).toHaveAttribute("data-size", "sm");
  await expect(save).toHaveAttribute("data-size", "sm");
});
