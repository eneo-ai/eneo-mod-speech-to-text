/**
 * Audio streamed while recorded (Strömma) goes to Eneo as streamed, with the live text the relay stored when there is one.
 * When Eneo could not use the live text, the result says why and which model transcribed the audio instead. A recording
 * made with Spela in and a chosen file never go as streamed.
 */
import type { Page } from "@playwright/test";
import ids from "../fixtures/ids.json";
import { expect, test } from "./gate";
import { chooseFile, NO_CONFIRMED_WORDS, record, run, setup, STATES, stop } from "./screens";
import { declare } from "./sentinel";

test.beforeEach(({ page }, info) => {
  test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "one laptop and one phone");
  declare(page, [NO_CONFIRMED_WORDS]);
});

const NOTICE = "Livetexten kunde inte användas";
/** The notice, apart from the page's other notes (the flow's information class beside a run). */
const notice = (page: Page) => page.getByRole("note").filter({ hasText: NOTICE });

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
  await expect(notice(page)).toHaveText(
    `${NOTICE}Körningen fick ingen färdig livetext. Ljudfilerna transkriberades med KB Whisper i stället.`,
  );
  await expect(notice(page)).toBeVisible();
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

test("while the run goes, the step that decided against its live text says so, and with which model it is transcribed", async ({ page }, info) => {
  await STATES.find((state) => state.name === "run-progress-live-fallback")!.go(page, info);
  await expect(notice(page)).toHaveText(
    `${NOTICE}Körningen fick ingen färdig livetext. Ljudfilerna transkriberas med KB Whisper i stället.`,
  );
});

test("a new run of a streamed recording's audio goes as streamed, with the live transcript its run named", async ({ page }) => {
  // A cancelled run, whose audio Eneo says was streamed with a live transcript: Starta en ny körning is its way on.
  await page.route(new RegExp(`/runs/${ids.runs.failed}/(status/)?$`), async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), status: "cancelled", error: null } });
  });
  await page.route(new RegExp(`/runs/${ids.runs.failed}/steps/?$`), async (route) => {
    const response = await route.fetch();
    const [transcription, ...rest] = await response.json();
    const submitted = { runtime_input_streamed: true, runtime_input_live_transcript_id: "00000000-0000-4000-b000-999999999999" };
    await route.fulfill({ response, json: [{ ...transcription, ...submitted }, ...rest] });
  });
  await run(page, ids.runs.failed);
  await expect(page.getByRole("heading", { name: "Körningen avbröts" })).toBeVisible();
  const request = page.waitForRequest((r) => r.method() === "POST" && /\/flows\/[^/]+\/runs\/?$/.test(new URL(r.url()).pathname));
  await page.getByRole("button", { name: "Starta en ny körning" }).click();
  expect((await request).postDataJSON().step_inputs[ids.steps.audio]).toEqual({
    file_ids: [ids.files.audioA, ids.files.audioB],
    streamed: true,
    live_transcript_id: "00000000-0000-4000-b000-999999999999",
  });
  // The stub does not know that transcript: the new run says so once done.
  await expect(notice(page)).toContainText("Livetexten hittades inte.", { timeout: 30_000 });
});
