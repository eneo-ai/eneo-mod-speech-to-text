/**
 * Naming the speakers of a finished run whose flow has no naming step: the names are saved with the transcript's
 * corrections, show at once in the transcript, its copy and its text, and reach the document when it is made again.
 * The stub keeps the corrections of a run the page started, and refuses names as Eneo does.
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./gate";
import { api, isLaptop, run, startedRun } from "./screens";
import { declare } from "./sentinel";
import ids from "../fixtures/ids.json";

// Nämndmöte till rapport: it transcribes, then writes its document. No step names the speakers.
const FLOW = ids.flows.flow1;

test.beforeEach(({}, info) => test.skip(!["phone-390-light", "laptop-1440-light"].includes(info.project.name), "a phone and a laptop"));

/** Chooses an action of the transcript's heading: beside it where the row has room, in its menu where it has not. */
async function transcriptAction(page: Page, name: string) {
  const inRow = page.getByRole("button", { name, exact: true });
  if (await inRow.isVisible()) return inRow.click();
  await page.getByRole("button", { name: "Fler alternativ för transkriberingen" }).click();
  await page.getByRole("menuitem", { name: name.replace(/, transkriberingen$/, ""), exact: true }).click();
}

test("names are refused as Eneo refuses them: on a run that is not done, and for a speaker the transcript does not have", async ({ page }) => {
  declare(page, [{ console: /status of 400.*\/transcript-corrections\// }]);
  const { id, finish } = await startedRun(page);
  const { json: steps } = await api(page, "GET", `${FLOW}/runs/${ids.runs.done}/steps/`);
  const hash = (steps as unknown as { input_payload_json: { transcription: { segments_hash: string } } }[])[0].input_payload_json.transcription.segments_hash;
  const save = (names: Record<string, string | null>) =>
    api(page, "PATCH", `${FLOW}/runs/${id}/steps/${ids.steps.audio}/transcript-corrections/`, {
      schema_version: 3, segments_hash: hash, expected_revision: null, occurrences: [], speaker_edits: [], speaker_names: names,
    });
  expect(await save({ SPEAKER_00: "Anna Berg" }), "the run still runs").toMatchObject({ status: 400, json: { context: { reason: "run_not_completed" } } });
  await finish();
  expect(await save({ SPEAKER_07: "Ingen" }), "no such speaker").toMatchObject({ status: 400, json: { context: { reason: "unknown_speaker_label" } } });
  expect(await save({ SPEAKER_00: " Anna Berg ", SPEAKER_01: "" })).toMatchObject({ status: 200, json: { revision: 1, speaker_names: { SPEAKER_00: "Anna Berg", SPEAKER_01: null } } });
});

test("names given to a finished run's speakers show in its transcript, its copy and its text, and in the document made again", async ({ page }, info) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void (document.body.dataset.copiedText = text) },
    });
  });
  const { id, finish } = await startedRun(page);
  await finish();
  await run(page, id);
  await expect(page.getByRole("heading", { level: 1, name: "Dokumentet är klart" })).toBeVisible();
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();

  const naming = page.getByRole("button", { name: "Namnge talare" });
  await naming.click();
  const dialog = page.getByRole("dialog", { name: "Namnge talarna" });
  await expect(dialog.getByText("Namnen syns direkt i transkriberingen, även när du kopierar den eller laddar ner den som text. Dokumentet får namnen när du skapar det igen.")).toBeVisible();
  for (const [speaker, name] of [["Talare 1", "Anna Berg"], ["Talare 2", "Erik Lund"]]) {
    await dialog.getByRole("combobox", { name: `Vem är ${speaker}?` }).fill(name);
    // Typing opens the name list over what is below the field; a press outside it closes it first.
    await dialog.getByRole("heading", { name: "Namnge talarna" }).click();
  }
  await dialog.getByRole("button", { name: "Spara namnen" }).click();
  await expect(dialog).toBeHidden();
  await expect(naming, "the focus is back where the naming was opened").toBeFocused();

  // At once, everywhere the transcript names a speaker.
  await expect(page.getByRole("button", { name: "Anna Berg, ändra talare" })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Erik Lund, ändra talare" })).toHaveCount(2);
  const text = [
    "## Del 1",
    "",
    "[00:00:00 - 00:00:03] Anna Berg: Välkomna till kommunstyrelsens möte.",
    "[00:00:03 - 00:00:06] Erik Lund: Första punkten gäller budgeten för nästa år.",
    "[00:00:06 - 00:00:11] Anna Berg: Ramen höjs med två procent och förvaltningen återkommer i oktober.",
    "",
    "## Del 2",
    "",
    "[00:00:00 - 00:00:03] Erik Lund: Andra punkten är skolskjutsarna.",
    "[00:00:03 - 00:00:07] Anna Berg: Nya turer börjar gälla efter höstlovet.",
  ].join("\n");
  await transcriptAction(page, "Kopiera transkriberingen");
  await expect(page.locator("body")).toHaveAttribute("data-copied-text", text);
  const download = page.waitForEvent("download");
  await transcriptAction(page, "Ladda ner som text, transkriberingen");
  const chunks: Buffer[] = [];
  for await (const chunk of await (await download).createReadStream()) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks).toString("utf8"), "the text download").toBe(text);

  // The document is older than the names: the notice says what a new one adds, and makes it.
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Dokument" }).click();
  const notice = page.getByRole("note").filter({ hasText: "Dokumentet skapades före dina ändringar" });
  await expect(notice).toContainText("Namnen syns redan i transkriberingen, och dokumentet får dem när du skapar det igen.");
  await notice.getByRole("button", { name: "Skapa dokumentet igen" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dokumentet skapas" })).toBeVisible();

  // The new run: its document is the transcript under the names, and its transcript names them too.
  await expect(page.getByRole("heading", { level: 1, name: "Dokumentet är klart" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/från den rättade transkriberingen$/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Förhandsvisning av texten i filen" })).toContainText(
    "[00:00:00 - 00:00:03] Anna Berg: Välkomna till kommunstyrelsens möte.",
  );
  await expect(page.getByRole("note"), "nothing newer than the new document").toHaveCount(0);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  await expect(page.getByRole("button", { name: "Anna Berg, ändra talare" })).toHaveCount(3);
});

test("Namnge talare ends the speakers' own row above their chips, before the transcript's actions under the tabs, and the word at the row's start names the chips; on a phone the list stands in the word's place, the naming and the menu as icons at its end", async ({ page }, info) => {
  await run(page, ids.runs.done);
  await expect(page.getByRole("heading", { level: 1, name: "Dokumentet är klart" })).toBeVisible();
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const player = page.getByRole("region", { name: "Inspelning och transkribering" });
  const naming = player.getByRole("button", { name: "Namnge talare" });
  // A phone at its narrowest too, where the row has the least room; a tablet's row as a laptop's.
  for (const width of isLaptop(info) ? [1440] : [768, 390, 320]) {
    await page.setViewportSize({ width, height: info.project.use.viewport!.height });
    const phone = width < 640;
    // The row starts with the speakers' word, which names the chips under it; on a phone with the list that stands in
    // for them, named by the same word.
    // The list's field, whose edge is the row's start (its combobox is the words inside it).
    const start = phone
      ? player.getByRole("combobox", { name: "Talare" }).locator("xpath=..")
      : player.getByText("Talare", { exact: true }).filter({ visible: true });
    // A ghost button's padding stands outside the column: its words end on the edge. Under the result's tabs the
    // transcript's copy and download follow it and end the row (on a phone, folded into their menu).
    const rowEnd = isLaptop(info)
      ? naming.getByText("Namnge talare", { exact: true })
      : phone
        ? player.getByRole("button", { name: "Fler alternativ för transkriberingen" })
        : player.getByRole("button", { name: /^Ladda ner som text/ }).getByText("Ladda ner som text", { exact: true });
    // Under the row: the chips, or on a phone the search.
    const under = phone ? player.getByRole("textbox", { name: "Sök i transkriberingen" }) : player.getByRole("group", { name: "Talare", exact: true });
    await expect(start).toBeVisible();
    await expect(under).toBeVisible();
    const [region, first, action, end, below] = await Promise.all([player, start, naming, rowEnd, under].map(async (part) => (await part.boundingBox())!));
    const middle = (box: typeof region) => box.y + box.height / 2;
    expect(
      {
        oneRow: Math.abs(middle(first) - middle(action)) <= 1 && Math.abs(middle(end) - middle(action)) <= 1,
        atStart: phone || Math.round(first.x) === Math.round(below.x),
        // The row's end mirrors its start: the last action ends as far from the transcript's edge as the row starts from
        // the other.
        atEnd: Math.round(region.x + region.width - (end.x + end.width)) === Math.round(first.x - region.x),
        aboveTheRest: action.y + action.height <= below.y && first.y + first.height <= below.y,
      },
      `${width} px`,
    ).toEqual({ oneRow: true, atStart: true, atEnd: true, aboveTheRest: true });
  }
});

test("Byt namn på in a passage's Ändra talare opens the naming at that speaker, and Avbryt (on a phone's whole screen the title's Stäng) gives the focus back to the passage", async ({ page }, info) => {
  await run(page, ids.runs.done);
  await expect(page.getByRole("heading", { level: 1, name: "Dokumentet är klart" })).toBeVisible();
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const passage = page.getByRole("button", { name: "Talare 2, ändra talare" }).first();
  await passage.click();
  await page.getByRole("dialog", { name: "Ändra talare" }).getByRole("button", { name: "Byt namn på Talare 2" }).click();
  const dialog = page.getByRole("dialog", { name: "Namnge talarna" });
  await expect(dialog.getByRole("combobox", { name: "Vem är Talare 2?" })).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Ändra talare" })).toHaveCount(0);
  // The people the run was started with are offered as names, before anyone is named.
  await dialog.getByRole("combobox", { name: "Vem är Talare 2?" }).click();
  await expect(page.getByRole("listbox").getByRole("option", { name: "Erik Lund" })).toBeVisible();
  await dialog.getByRole("heading", { name: "Namnge talarna" }).click();
  await dialog.getByRole("button", { name: info.project.use.viewport!.width < 480 ? "Stäng" : "Avbryt", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(passage).toBeFocused();
});
