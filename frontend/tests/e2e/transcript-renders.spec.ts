/**
 * A two-hour meeting's transcript (the stub's run `long`: 2,000 passages, three speakers, every word timed) renders only the
 * passages an interaction reaches. Counted renders, not milliseconds: a time varies with the machine, a count does not, and a
 * change that hands every passage a new prop or closure turns each interaction back into 2,000 renders (450-950 ms on a phone).
 */
import type { Page, TestInfo } from "@playwright/test";
import ids from "../fixtures/ids.json";
import { expect, test } from "./gate";
import { countRenders } from "./react-renders";
import { isLaptop, pick, result, run } from "./screens";
import { REAL } from "./sentinel";

// One laptop and one phone: the renders are the same on every project, and the long run is not worth 20 copies. The built
// app on the real target has minified component names, which the counting reads.
test.beforeEach(({}, info) =>
  test.skip(REAL || !["laptop-1440-light", "phone-390-light"].includes(info.project.name), "counts renders on the dev profile, on a laptop and a phone"),
);

/** Slack for a render the interaction causes beside the passages it names (a focus move, a status). */
const SLACK = 10;

const passages = (page: Page) => page.locator("[data-turn-index]");

/** How many passages' text contains `pattern`, read from the page and not from the app's own search. */
const passagesWith = (page: Page, pattern: string) =>
  page.evaluate(
    (source) => [...document.querySelectorAll("[data-turn-index]")].filter((passage) => new RegExp(source, "i").test(passage.textContent ?? "")).length,
    pattern,
  );

/** The long run's transcript on screen, every passage mounted and rendering stopped; `mounted` is the renders it took. */
async function openLong(page: Page, info: TestInfo) {
  const turns = await countRenders(page, "TurnBlock");
  await run(page, ids.runs.long);
  await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toBeVisible();
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  await expect.poll(() => passages(page).count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(1_500);
  const mounted = await turns.settled();
  await turns.reset();
  return { turns, mounted, total: await passages(page).count() };
}

test("every passage renders once when the transcript opens, which shows that the counting sees them", async ({ page }, info) => {
  const { mounted } = await openLong(page, info);
  expect(mounted, "the passages rendered at mount").toBeGreaterThanOrEqual(1_500);
});

test("one more letter in the search renders the passages whose hits change, not the transcript", async ({ page }, info) => {
  const { turns, total } = await openLong(page, info);
  const search = page.getByPlaceholder("Sök i transkriberingen");
  const withHits = page.locator("[data-turn-index]:has([data-hit])");
  // "gäll" is in two of the meeting's sentences, "gälle" in one: the second query's hits are among the first's.
  const broad = await passagesWith(page, "gäll");
  const narrow = await passagesWith(page, "gälle");
  expect(narrow, "the second query narrows the first").toBeGreaterThan(0);
  expect(narrow).toBeLessThan(broad);
  expect(broad, "and the first is a part of the transcript").toBeLessThan(total);

  await search.fill("gäll");
  await expect.poll(() => withHits.count(), { timeout: 30_000 }).toBe(broad);
  await turns.settled();
  await turns.reset();

  await search.pressSequentially("e");
  await expect.poll(() => withHits.count(), { timeout: 30_000 }).toBe(narrow);
  const renders = await turns.settled();
  expect(renders, `passages rendered for one more letter (the ${broad} that had hits, ${narrow} keep them, of ${total})`).toBeLessThanOrEqual(broad + SLACK);
});

test("Rätta on one passage renders that passage and no other", async ({ page }, info) => {
  const { turns } = await openLong(page, info);
  await page.getByRole("button", { name: "Rätta repliken från 0:03" }).first().click();
  await expect(page.getByRole("textbox", { name: /Rätta repliken/ })).toBeVisible();
  const renders = await turns.settled();
  // The passage being edited must render: a count of nothing would mean the counting no longer sees updates.
  expect(renders, "the edited passage rendered, so updates are counted").toBeGreaterThanOrEqual(1);
  expect(renders, "passages rendered by opening one correction").toBeLessThanOrEqual(5);
});

test("choosing a speaker and then everyone renders the passages that appear, not the ones that stay", async ({ page }, info) => {
  const { turns, total } = await openLong(page, info);
  const first = await page.locator('[data-turn-index][aria-label^="Talare 1,"]').count();
  expect(first, "the first speaker has some of the passages").toBeGreaterThan(0);
  expect(first).toBeLessThan(total);

  // Chips from 640 px; on a phone the list in the speakers' row.
  const phone = info.project.use.viewport!.width < 640;
  const choose = (speaker: string) =>
    phone ? pick(page.getByRole("combobox", { name: "Talare" }), speaker === "Alla" ? "Alla talare" : speaker) : page.getByRole("button", { name: speaker, exact: true }).click();
  await choose("Talare 1");
  await expect.poll(() => passages(page).count(), { timeout: 30_000 }).toBe(first);
  // Passages leave; none appears, and those that stay are not rendered again.
  expect(await turns.settled(), "passages rendered while the others left").toBeLessThanOrEqual(SLACK);
  await turns.reset();

  await choose("Alla");
  await expect.poll(() => passages(page).count(), { timeout: 30_000 }).toBe(total);
  expect(await turns.settled(), `passages rendered for the ${total - first} that appear (the ${first} that stayed are not among them)`).toBeLessThanOrEqual(total - first + SLACK);
});

test("a search with its count and arrows keeps a field to read what was typed in, under the chips it shared a row with", async ({ page }, info) => {
  test.skip(!isLaptop(info), "where the chips and the search share a row; a phone gives the search a row of its own");
  await result(page);
  const search = page.getByRole("textbox", { name: "Sök i transkriberingen" });
  await search.fill("budget");
  await expect(page.getByRole("button", { name: "Nästa träff" })).toBeVisible();
  expect((await search.boundingBox())!.width, "the search field's width with a query typed").toBeGreaterThanOrEqual(160);
});

test("playing and pausing renders no passage", async ({ page }, info) => {
  const { turns } = await openLong(page, info);
  const audio = page.locator("audio").first();
  await page.getByRole("button", { name: "Spela upp", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Pausa uppspelningen" })).toBeVisible();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime), { message: "the audio played" }).toBeGreaterThan(0.5);
  await page.getByRole("button", { name: "Pausa uppspelningen" }).click();
  await expect(page.getByRole("button", { name: "Spela upp", exact: true }).first()).toBeVisible();
  expect(await turns.settled(), "passages rendered by playing and pausing").toBeLessThanOrEqual(5);
});

test("while the recording plays, its player renders as often as its thumb moves, not on every frame", async ({ page }, info) => {
  const player = await countRenders(page, "AudioPlayer");
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  await player.settled();
  await player.reset();
  await page.locator("[data-docked-player]").getByRole("button", { name: "Spela upp" }).click();
  await page.waitForTimeout(3_000);
  const renders = await player.renders();
  await page.getByRole("button", { name: "Pausa uppspelningen" }).first().click();
  // A 20 s recording on an 800 px track moves its thumb a pixel every 25 ms: at most 20 times a second, 60 in 3 s. Drawn
  // on every frame it was about 180.
  expect(renders, "the thumb is drawn while it plays").toBeGreaterThan(10);
  expect(renders, "renders in 3 s of playing").toBeLessThan(90);
});
