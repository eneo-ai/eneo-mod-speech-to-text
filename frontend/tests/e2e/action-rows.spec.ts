/**
 * A step's decision is one row with one rule (components/ActionRow.tsx, as the design system's alert dialog has it): up to
 * 640 px wide its buttons stack across the whole row, the main one on top and first for the keyboard; wider, they stand
 * in one row at its end, the main one last. An editor's own buttons are no decision: small, in the text's header above
 * it, and Spara ändring only while there is a change to save. A long text keeps the header and the decision in view.
 */
import { type Locator } from "@playwright/test";
import ids from "../fixtures/ids.json";
import { expect, test } from "./gate";
import { keptRecording, run, STATES } from "./screens";

// A phone and a laptop; what is about the narrowest phone's first screen, there too.
test.beforeEach(({}, info) =>
  test.skip(![...(info.title.includes("narrowest phone") ? ["phone-320-light"] : []), "phone-390-light", "laptop-1440-light"].includes(info.project.name), "a phone and a laptop"),
);

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

test("who is who: Godkänn och fortsätt is whole on the narrowest phone's first screen, and what it does to speakers without a name follows it on a phone", async ({ page }, info) => {
  await run(page, ids.runs.review, ids.flows.flow2);
  await expect(page.getByRole("heading", { name: "Vem är vem?", level: 1 })).toBeVisible();
  const approve = (await page.getByRole("button", { name: "Godkänn och fortsätt" }).boundingBox())!;
  const reject = (await page.getByRole("button", { name: "Avvisa körningen", exact: true }).boundingBox())!;
  const note = (await page.getByText("Talare utan namn behåller sin etikett i transkriberingen.").boundingBox())!;
  const { width, height } = info.project.use.viewport!;
  if (width < 640) {
    expect(note.y, "the note under the decision's buttons").toBeGreaterThan(Math.max(approve.y + approve.height, reject.y + reject.height));
    if (width < 360) expect(approve.y + approve.height, "Godkänn och fortsätt whole on the first screen").toBeLessThanOrEqual(height);
  } else {
    expect(note.y + note.height, "the note in the speakers' card, above the decision").toBeLessThan(approve.y);
  }
});

for (const review of REVIEWS) {
  test(`${review.name}: Avvisa and Godkänn och fortsätt follow the decision's rule`, async ({ page }, info) => {
    await run(page, review.id, review.flow);
    await expect(page.getByRole("heading", { name: review.heading, level: 1 })).toBeVisible();
    const found = await layout(page.getByRole("button", { name: "Godkänn och fortsätt" }), page.getByRole("button", { name: "Avvisa körningen", exact: true }));
    followsTheRule(found, info.project.use.viewport!.width <= 640);
  });
}

test("an unsent recording on the setup: its send keeps one line on the narrowest phone, the words shown starting its name", async ({ page }, info) => {
  await STATES.find((s) => s.name === "unsent-on-setup")!.go(page, info);
  const send = page.getByRole("button", { name: "Skapa dokument av inspelningen" });
  await expect(send).toHaveText(info.project.use.viewport!.width < 360 ? "Skapa dokument" : "Skapa dokument av inspelningen");
  const lines = await send.evaluate((button) => {
    const range = document.createRange();
    range.selectNodeContents(button);
    return new Set([...range.getClientRects()].filter((rect) => rect.width > 1).map((rect) => Math.round(rect.top))).size;
  });
  expect(lines, "its words on one line").toBe(1);
});

test("a stopped unsent recording's send is its one filled way on, across its card on a phone, Fortsätt spela in and Spara ljudfil share the row under it and Ta bort ends that row at its own width, and all in one row wider, Ta bort last; its delete question is a decision", async ({ page }, info) => {
  await page.goto("/flows");
  await keptRecording(page, 1_000);
  await page.reload();
  const card = page.getByRole("region", { name: "En inspelning har inte skickats" });
  const actions = card.getByRole("button");
  // Sending a stopped recording is likelier than recording on in it (one a reload cut off leads with Fortsätt spela in).
  await expect(actions).toHaveText(["Skapa dokument", "Fortsätt spela in", "Spara ljudfil", "Ta bort"]);
  await expect(card.locator('button[data-variant="primary"]'), "one filled way on").toHaveText(["Skapa dokument"]);
  const boxes = await actions.evaluateAll((buttons) =>
    buttons.map((button) => {
      const { left, right, top, bottom } = button.getBoundingClientRect();
      // Where its words end, for the ghost one: its padding stands outside the column.
      const text = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      let words = right;
      for (let node = text.nextNode(); node; node = text.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        words = range.getBoundingClientRect().right;
      }
      return { left: Math.round(left), right: Math.round(right), top: Math.round(top), bottom: Math.round(bottom), middle: Math.round((top + bottom) / 2), words: Math.round(words) };
    }),
  );
  const stacked = info.project.use.viewport!.width <= 640;
  const [send, resume, save, remove] = boxes;
  const seen = stacked
    ? {
        // Skapa dokument across the card; Fortsätt spela in and Spara ljudfil share the row under it from its edges, and
        // Ta bort ends their row (or the line under it, where the row has no room) at its own width, its words on the
        // card's content edge (a ghost button's padding stands outside it).
        quietUnder: resume.top >= send.bottom && save.middle === resume.middle,
        fromTheEdges: resume.left === send.left && save.right <= send.right && Math.abs(remove.words - send.right) <= 2,
        deleteLast: remove.top >= save.top && remove.left > resume.right,
        ownWidth: remove.right - remove.left < save.right - save.left,
      }
    : {
        // One line through their middles: the filled one is the page's own size, the quiet ones the middle size.
        oneRow: boxes.every((box) => Math.abs(box.middle - boxes[0].middle) <= 1),
        inOrder: boxes.every((box, i) => i === 0 || box.left > boxes[i - 1].right),
      };
  expect(seen, JSON.stringify(boxes)).toEqual(
    stacked ? { quietUnder: true, fromTheEdges: true, deleteLast: true, ownWidth: true } : { oneRow: true, inOrder: true },
  );

  await card.getByRole("button", { name: "Ta bort" }).click();
  followsTheRule(await layout(card.getByRole("button", { name: "Ta bort" }), card.getByRole("button", { name: "Avbryt" })), stacked);
});

test("the text review's editor: its buttons stand small in the text's header, Spara ändring only with a change", async ({ page }) => {
  await run(page, ids.runs.reviewText);
  await page.getByRole("button", { name: "Redigera" }).click();
  const field = page.getByRole("textbox", { name: "Innehåll för granskning" });
  const cancel = page.getByRole("button", { name: "Avbryt redigering" });
  const save = page.getByRole("button", { name: "Spara ändring" });
  await expect(cancel).toBeVisible();
  await expect(save, "nothing to save yet").toHaveCount(0);
  await field.fill("Kommunstyrelsen beslutade att höja budgetramen med tre procent.");
  await expect(save).toBeVisible();
  const [fieldBox, cancelBox, saveBox] = await Promise.all([field, cancel, save].map((element) => element.boundingBox()));
  expect(
    {
      aboveTheField: cancelBox!.y + cancelBox!.height <= fieldBox!.y,
      // Beside the text's name where the row has room, under it on a phone; within the field's width either way.
      withinTheField: cancelBox!.x >= fieldBox!.x - 2 && saveBox!.x + saveBox!.width <= fieldBox!.x + fieldBox!.width + 2,
      saveBeside: Math.round(saveBox!.y) === Math.round(cancelBox!.y) && saveBox!.x > cancelBox!.x + cancelBox!.width,
    },
    JSON.stringify({ field: fieldBox, cancel: cancelBox, save: saveBox }),
  ).toEqual({ aboveTheField: true, withinTheField: true, saveBeside: true });
  await expect(cancel).toHaveAttribute("data-size", "sm");
  await expect(save).toHaveAttribute("data-size", "sm");
});

test("a long text under review keeps Redigera and the decision in view, and opens for editing where it is read", async ({ page }) => {
  const short = "Kommunstyrelsen beslutade att höja budgetramen med två procent.";
  const long = Array.from({ length: 24 }, (_, i) => `## Punkt ${i + 1}\n\n${short} Förvaltningen återkommer i oktober med en plan.`).join("\n\n");
  await page.route("**/api/eneo/**", async (route) => {
    const response = await route.fetch();
    if (!(response.headers()["content-type"] ?? "").includes("json")) return route.fulfill({ response });
    const body = JSON.stringify(JSON.parse(await response.text()), (_, value) => (value === short ? long : value));
    return route.fulfill({ response, body });
  });
  await run(page, ids.runs.reviewText);
  const edit = page.getByRole("button", { name: "Redigera" });
  const approve = page.getByRole("button", { name: "Godkänn och fortsätt" });
  const inView = (locator: Locator) =>
    locator.evaluate((element) => {
      const { top, bottom } = element.getBoundingClientRect();
      return top >= 0 && bottom <= innerHeight;
    });
  await expect(edit).toBeVisible();
  expect({ edit: await inView(edit), approve: await inView(approve) }, "at the text's start").toEqual({ edit: true, approve: true });

  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight / 2));
  const reading = await page.evaluate(() => scrollY);
  expect({ edit: await inView(edit), approve: await inView(approve) }, "half way through the text").toEqual({ edit: true, approve: true });

  await edit.click();
  const field = page.getByRole("textbox", { name: "Innehåll för granskning" });
  await expect(field).toBeFocused();
  const box = await field.evaluate((element) => ({ scroll: element.scrollHeight - element.clientHeight, at: scrollY }));
  expect({ oneScroll: box.scroll <= 1, stays: Math.abs(box.at - reading) <= 2 }, JSON.stringify({ ...box, reading })).toEqual({ oneScroll: true, stays: true });
  expect(await inView(page.getByRole("button", { name: "Avbryt redigering" })), "Avbryt redigering in view").toBe(true);
});
