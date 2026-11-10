/**
 * Audio streamed while recorded (Strömma) goes to Eneo as streamed, with the live text the relay stored when there is one.
 * When Eneo could not use the live text, the result says why and which model transcribed the audio instead. A recording
 * made with Spela in and a chosen file never go as streamed.
 */
import type { Page } from "@playwright/test";
import ids from "../fixtures/ids.json";
import { expect, test } from "./gate";
import { chooseFile, NO_CONFIRMED_WORDS, record, setup, stop } from "./screens";
import { declare } from "./sentinel";

test.beforeEach(({ page }, info) => {
  test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "one laptop and one phone");
  declare(page, [NO_CONFIRMED_WORDS]);
});

const NOTICE = "Livetexten kunde inte användas";

/** Skapa dokument: the run request's input for the audio step, as the page sent it, and the run's result once done. */
async function send(page: Page) {
  const request = page.waitForRequest((r) => r.method() === "POST" && /\/flows\/[^/]+\/runs\/?$/.test(new URL(r.url()).pathname));
  await page.getByRole("button", { name: "Skapa dokument" }).click();
  const input = (await request).postDataJSON().step_inputs[ids.steps.audio];
  await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toBeVisible({ timeout: 30_000 });
  return input;
}

test("Strömma's recording goes as streamed with the live text the relay stored, and its result has nothing to say about it", async ({ page }) => {
  await setup(page);
  await record(page, "Strömma");
  await expect(page.getByRole("log", { name: "Preliminär text" })).toContainText("Välkomna", { timeout: 15_000 });
  await stop(page);
  expect(await send(page)).toEqual({
    file_ids: [expect.any(String)],
    streamed: true,
    live_transcript_id: expect.stringMatching(/^00000000-0000-4000-b000-/),
  });
  await expect(page.getByText(NOTICE)).toHaveCount(0);
});

test("Strömma's recording whose final text does not come within the relay's budget still goes as streamed, and the result says why", async ({ page }) => {
  // A relay that keeps the text, gives the session two seconds after the stop, and never answers it.
  await page.routeWebSocket(/\/api\/live\//, (ws) => {
    ws.send(JSON.stringify({ type: "ready", sample_rate: 16000, max_seconds: 18000, keeps_transcript: true, finish_within_seconds: 2 }));
    ws.send(JSON.stringify({ type: "transcript.delta", text: "Välkomna" }));
  });
  await setup(page);
  await record(page, "Strömma");
  await expect(page.getByRole("log", { name: "Preliminär text" })).toContainText("Välkomna");
  await stop(page);
  expect(await send(page)).toEqual({ file_ids: [expect.any(String)], streamed: true });
  // Read where it stands, with nothing to open first.
  await expect(page.getByRole("note")).toHaveText(
    `${NOTICE}Körningen fick ingen färdig livetext. Ljudfilerna transkriberades med KB Whisper i stället.`,
  );
  await expect(page.getByRole("note")).toBeVisible();
});

test("a recording made with Spela in never goes as streamed", async ({ page }) => {
  await setup(page);
  await record(page, "Spela in");
  await page.waitForTimeout(1_500);
  await stop(page);
  expect(await send(page)).toEqual({ file_ids: [expect.any(String)] });
  await expect(page.getByText(NOTICE)).toHaveCount(0);
});

test("a chosen file never goes as streamed", async ({ page }) => {
  await setup(page);
  await chooseFile(page);
  expect(await send(page)).toEqual({ file_ids: [expect.any(String)] });
});
