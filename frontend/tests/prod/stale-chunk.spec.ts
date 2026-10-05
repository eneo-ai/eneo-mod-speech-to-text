/**
 * A tab that was open across a deploy asks for chunks the new build does not have: the backend answers a hashed file that
 * is gone with a 404 that is not a page (tests/prod/routes.spec.ts), and the browser cannot import it. Each test refuses one
 * chunk that way, on the real backend, and checks what a person is left with:
 *
 *   - code a page loads for one part of itself (the calendar, the formatted text, the review editor): that part stays as
 *     it was, a status line says what happened, and its one action, "Ladda om sidan", reloads on the person's press;
 *   - code a route needs: the route's page is replaced by "Sidan kunde inte visas." inside the app's frame, with the same
 *     reload as a button.
 *
 * Nothing reloads by itself: a person may be in the middle of something on a page that is still open. A browser keeps a
 * failed import of a module per address (Chromium makes no second request for it), so the recovery is a reload, and the
 * test lifts the refusal before it presses, as the deploy's new files would be there by then.
 */
import { expect, test as base, type Page } from "@playwright/test";
import { test as signedIn } from "../e2e/auth";
import ids from "../fixtures/ids.json";
import { removeChunk, watchForReloads } from "./gone-chunks";

const reloadButton = (page: Page) => page.getByRole("button", { name: "Ladda om sidan" });

signedIn("a calendar that cannot be fetched leaves the plain date field and a line, and the reload the person chooses brings the calendar and what was typed @chromium", async ({ session, page }) => {
  expect(session.user).toBeTruthy();
  const chunk = await removeChunk(page, "DateInput");
  await page.goto(`/flows/${ids.flows.flow5}`);
  const line = page.getByRole("status").filter({ hasText: "Kalendern kunde inte läsas in." });
  await expect(line).toContainText("Det du har skrivit finns kvar.");
  await expect(reloadButton(page)).toBeVisible();
  expect(chunk.refused.length, "the calendar's code was asked for and refused").toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Öppna kalender" })).toHaveCount(0);

  // The field takes a date as it is, and the page keeps what was typed where the line says it does.
  const date = page.getByRole("textbox", { name: "Mötesdatum" });
  await date.fill("2026-09-24");
  const reloads = await watchForReloads(page);
  expect(await reloads.stillTheSameTab(), "nothing reloaded the page by itself").toBe(true);
  await expect(date).toHaveValue("2026-09-24");

  await chunk.lift();
  await reloadButton(page).click();
  await expect(page.getByRole("button", { name: "Öppna kalender" })).toBeVisible();
  await expect(line).toHaveCount(0);
  await expect(page.getByLabel("Mötesdatum"), "what was typed, as the calendar shows it").toHaveValue("24 september 2026");
});

signedIn("text whose formatting cannot be fetched stays readable with a line, and the reload the person chooses formats it @chromium", async ({ session, page }) => {
  expect(session.user).toBeTruthy();
  const chunk = await removeChunk(page, "MarkdownFormatted");
  await page.goto(`/flows/${ids.flows.flow1}?run=${ids.runs.table}`);
  await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toBeVisible();

  const line = page.getByRole("status").filter({ hasText: "Texten visas utan formatering, den kunde inte läsas in." });
  await expect(line).toBeVisible();
  await expect(reloadButton(page)).toBeVisible();
  expect(chunk.refused.length, "the formatter's code was asked for and refused").toBeGreaterThan(0);
  await expect(page.getByText("Kommunstyrelsen fattade tre beslut.")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  const reloads = await watchForReloads(page);
  expect(await reloads.stillTheSameTab(), "nothing reloaded the page by itself").toBe(true);

  await chunk.lift();
  await reloadButton(page).click();
  await expect(page.getByRole("columnheader", { name: "Ärende" })).toBeVisible();
  await expect(line).toHaveCount(0);
});

signedIn("a page whose code cannot be fetched is replaced by a line and a reload button in the frame, and the reload the person chooses opens it @chromium", async ({ session, page }) => {
  expect(session.user).toBeTruthy();
  await page.goto("/flows");
  await expect(page.getByRole("link", { name: /Nämndmöte till rapport/ })).toBeVisible();
  const chunk = await removeChunk(page, "FlowPage");
  const reloads = await watchForReloads(page);

  // Within the app, as a person opens a flow from the list: the router asks for the page's code.
  await page.getByRole("link", { name: /Nämndmöte till rapport/ }).click();
  const heading = page.getByRole("heading", { name: "Sidan kunde inte visas." });
  await expect(heading).toBeVisible();
  expect(chunk.refused.length, "the page's code was asked for and refused").toBeGreaterThan(0);
  await expect(reloadButton(page)).toBeVisible();
  await expect(page.getByRole("link", { name: "Till startsidan" })).toBeVisible();
  expect(new URL(page.url()).pathname, "the address is the page's").toBe(`/flows/${ids.flows.flow1}`);
  expect(await reloads.stillTheSameTab(), "nothing reloaded the page by itself, and the frame around the page is the same").toBe(true);

  await chunk.lift();
  await reloadButton(page).click();
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
});

signedIn("a page opened by its address, whose code cannot be fetched, says so and the reload the person chooses opens it @chromium", async ({ session, page }) => {
  expect(session.user).toBeTruthy();
  const chunk = await removeChunk(page, "FlowsPage");
  await page.goto("/flows");

  await expect(page.getByRole("heading", { name: "Sidan kunde inte visas." })).toBeVisible();
  expect(chunk.refused.length).toBeGreaterThan(0);
  const reloads = await watchForReloads(page);
  expect(await reloads.stillTheSameTab(), "nothing reloaded the page by itself").toBe(true);

  await chunk.lift();
  await reloadButton(page).click();
  await expect(page.getByRole("heading", { name: "Välj ett flöde" })).toBeVisible();
});

base("the review editor whose code cannot be fetched leaves the transcript with a line, and the reload the person chooses brings the editor @fixture", async ({ page }) => {
  const chunk = await removeChunk(page, "TranscriptEditor");
  await page.goto("/dev/speaker-review");

  const line = page.getByRole("status").filter({ hasText: "Granskningsverktygen kunde inte läsas in." });
  await expect(line).toContainText("Det du har skrivit finns kvar.");
  await expect(reloadButton(page)).toBeVisible();
  expect(chunk.refused.length, "the editor's code was asked for and refused").toBeGreaterThan(0);
  const editor = page.getByRole("textbox", { name: "Transkribering, markera ord för att redigera" });
  await expect(editor).toHaveCount(0);
  const reloads = await watchForReloads(page);
  expect(await reloads.stillTheSameTab(), "nothing reloaded the page by itself").toBe(true);

  await chunk.lift();
  await reloadButton(page).click();
  await expect(editor).toBeVisible();
});
