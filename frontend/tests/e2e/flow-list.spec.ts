/**
 * The flow list as a person meets it while it loads, when it is empty, cut, long-winded or broken, and how a row opens
 * a flow. The gate's states (a11y.spec) show the list with the stub's four flows; these are the cases they cannot reach.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { axe, blocking, endlessAnimations, reflow, targetSizes, unnamedControls } from "./checks";
import ids from "../fixtures/ids.json";
import { open } from "./screens";

test.beforeEach(({}, info) =>
  test.skip(
    !["phone-320-light", "phone-390-dark", "laptop-1440-light", "ultrawide-3440-light", "reduced-motion"].includes(info.project.name),
    "the phones, a laptop, the widest screen, and reduced motion for the loading state",
  ),
);

const FLOWS = "**/api/eneo/flows/?*";
const FLOW_1 = new RegExp(`/flows/${ids.flows.flow1}$`);
const SPACE = { space_id: "space-1", space_name: "Kommunledningskontoret" };
const flow = (id: string, name: string, extra: object = {}) => ({ id, name, is_published: true, input_type: "audio", ...SPACE, ...extra });
const answer = (items: object[], hasMore = false) => (route: Route) =>
  route.fulfill({ json: { items, has_more: hasMore, count: items.length } });

/** What a person reads of an alert: Next's route announcer is an empty one that is always there. */
const alert = (page: Page) => page.getByRole("alert").filter({ hasText: /\w/ });

const clean = async (page: Page) => {
  expect(blocking((await axe(page)).violations).map((v) => `${v.id}: ${v.help}`), "axe").toEqual([]);
  expect(await unnamedControls(page), "controls without a name").toEqual([]);
  expect(await targetSizes(page, 24, true), "targets under 24 px").toEqual([]);
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    expect(await targetSizes(page, 44, false), "targets under 44 px on a coarse pointer").toEqual([]);
  }
};

test("while the flows load a status says so, the placeholder rows are hidden from a screen reader, and nothing moves or loops", async ({ page }) => {
  await page.route(FLOWS, () => {});
  await open(page, "/flows");
  await expect(page.getByRole("status").filter({ hasText: "Laddar flödena…" })).toBeAttached();
  await expect(page.getByRole("heading", { name: "Välj ett flöde", level: 1 })).toBeVisible();
  const rows = page.locator('ul[aria-hidden="true"] > li');
  await expect(rows).toHaveCount(4);
  await expect(page.getByRole("link", { name: /Nämndmöte/ })).toHaveCount(0);
  await expect(alert(page)).toHaveCount(0);
  const before = await page.getByRole("heading", { level: 1 }).boundingBox();
  await page.waitForTimeout(300);
  expect(await page.getByRole("heading", { level: 1 }).boundingBox(), "the heading stays where it is").toEqual(before);
  // Reduced motion: the shimmer stands still.
  if (test.info().project.name === "reduced-motion") expect(await endlessAnimations(page)).toEqual([]);
  expect((await reflow(page)).horizontalScroll).toBe(false);
});

test("no flows to run says so in the user's words, in the outline, and shows no list", async ({ page }) => {
  await page.route(FLOWS, answer([]));
  await open(page, "/flows");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Det finns inga publicerade flöden som du kan använda än.", level: 2 })).toBeVisible();
  await expect(main.getByText("När ett flöde publiceras i Eneo visas det här.")).toBeVisible();
  await expect(main.getByRole("list")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Laddar flödena…" })).toHaveCount(0);
  await clean(page);
  expect((await reflow(page)).horizontalScroll).toBe(false);
});

test("a list Eneo cut at the cap says how many are shown", async ({ page }) => {
  // Eneo has more after every page: the module stops after five of 200.
  await page.route(FLOWS, (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    return answer(Array.from({ length: 200 }, (_, i) => flow(`flow-${offset + i}`, `Flöde ${offset + i + 1}`)), true)(route);
  });
  await open(page, "/flows");
  await expect(page.getByText(/Visar de första 1\s000 flödena\./)).toBeVisible();
  await expect(page.getByRole("main").getByRole("link")).toHaveCount(1000);
});

test("a list that cannot be shown says what and why, and offers no retry where trying again cannot help", async ({ page }) => {
  await page.route("**/api/config", (route) => route.fulfill({ json: { flow_list: null } }));
  await open(page, "/flows");
  await expect(alert(page)).toContainText("Flödena kunde inte visas.");
  await expect(alert(page)).toContainText("Flödena kan inte visas eftersom tjänsten saknar en inställning.");
  await expect(page.getByRole("button", { name: "Försök igen" })).toHaveCount(0);
  await clean(page);
  expect((await reflow(page)).horizontalScroll).toBe(false);
});

test("a failed list is tried again from the notice, and the flows then replace it", async ({ page }) => {
  // In development React asks twice, so the answer is a failure until the person has seen it and pressed the button.
  let failing = true;
  await page.route(FLOWS, (route) => (failing ? route.fulfill({ status: 503, json: { code: "internal_error" } }) : route.fallback()));
  await open(page, "/flows");
  await expect(alert(page)).toContainText("Flödena kunde inte visas.");
  failing = false;
  const retried = page.waitForRequest(FLOWS);
  await page.getByRole("button", { name: "Försök igen" }).click();
  await retried;
  await expect(page.getByRole("link", { name: /Nämndmöte till rapport/ })).toBeVisible();
  await expect(alert(page)).toHaveCount(0);
});

test("long names stay whole, descriptions keep to two lines, and every row is a target for a finger", async ({ page }) => {
  const unbroken = "Sammanträdesprotokoll".repeat(5).slice(0, 90);
  const spaced = "Nämndmöte till strukturerat protokoll med beslut reservationer och bilagor för alla ".repeat(2).slice(0, 120).trim();
  const long = "Transkriberar mötet och skapar ett protokoll med beslut och sammanfattning. ".repeat(4).slice(0, 300).trim();
  await page.route(
    FLOWS,
    answer([
      flow("a", unbroken, { description: "Ett namn utan mellanslag." }),
      flow("b", spaced, { description: long }),
      flow("c", "Utan beskrivning"),
      flow("d", "Okänd indata", { description: "Ett flöde som tar emot något Eneo hittat på.", input_type: "video" }),
    ]),
  );
  await open(page, "/flows");
  await expect(page.getByRole("link", { name: /^Utan beskrivning$/ })).toBeVisible();

  const rows = await page.getByRole("main").locator("li").evaluateAll((items) =>
    items.map((li) => {
      const link = li.querySelector("a")!;
      const [label, description] = Array.from(link.children) as HTMLElement[];
      const lines = (el: HTMLElement) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
      // Neither the label's box nor the text inside it may cut or ellipsise.
      const cuts = [label, (label.firstElementChild ?? label) as HTMLElement].map((el) => {
        const s = getComputedStyle(el);
        return `${s.textOverflow}/${s.whiteSpace}/${s.overflow}`;
      });
      return {
        name: label.textContent,
        cuts,
        nameWhole: label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= label.clientHeight + 1,
        description: description?.textContent ?? null,
        descriptionLines: description ? lines(description) : 0,
        row: li.getBoundingClientRect().height,
      };
    }),
  );
  expect(rows.map((row) => row.name)).toEqual([unbroken, spaced, "Utan beskrivning", "Okänd indata"]);
  for (const row of rows) {
    for (const cut of row.cuts) expect(cut, `${row.name}: not ellipsised, not one line`).toMatch(/^clip\/(?!nowrap)[a-z-]+\/visible$/);
    expect(row.nameWhole, `${row.name}: whole`).toBe(true);
    expect(row.descriptionLines, `${row.name}: at most two lines`).toBeLessThanOrEqual(2);
  }
  expect(rows[1].descriptionLines, "a 300-character description fills its two lines").toBe(2);
  expect(rows[2].description).toBeNull();

  const layout = await reflow(page);
  expect(layout.horizontalScroll, "horizontal scroll").toBe(false);
  expect(layout.beyond, "content past the edge").toEqual([]);
  await clean(page);
});

test("the whole row opens the flow: the icon, the chevron and the row's own padding as much as its words", async ({ page }) => {
  await open(page, "/flows");
  const first = page.getByRole("link", { name: /^Nämndmöte till rapport/ });
  await expect(first).toBeVisible();
  const row = page.getByRole("main").locator("li", { has: first });
  const box = (await row.boundingBox())!;
  const at = async (selector?: string, last = false) => {
    const svg = row.locator(selector ?? "svg");
    const target = selector ? (await (last ? svg.last() : svg.first()).boundingBox())! : { x: box.x + 1, y: box.y + box.height / 2, width: 0, height: 0 };
    return [target.x + target.width / 2, target.y + target.height / 2] as const;
  };
  // The leading icon (the first svg), the chevron (the last) and the row's edge.
  for (const [what, point] of [
    ["the icon", await at("svg")],
    ["the chevron", await at("svg", true)],
    ["the row's padding", await at()],
  ] as const) {
    await open(page, "/flows");
    await expect(first).toBeVisible();
    await page.mouse.click(...point);
    await expect(page, what).toHaveURL(FLOW_1);
  }
});

test("opening a flow is a navigation inside the page, not a page load", async ({ page }) => {
  await open(page, "/flows");
  await page.evaluate(() => ((window as unknown as { __marker: boolean }).__marker = true));
  await page.getByRole("link", { name: /^Nämndmöte till rapport/ }).click();
  await expect(page).toHaveURL(FLOW_1);
  expect(await page.evaluate(() => (window as unknown as { __marker?: boolean }).__marker), "the page was not reloaded").toBe(true);
});
