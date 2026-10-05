/**
 * A deployment while someone records: the page holds audio that no one else has. Every script of the build that the page
 * has not fetched by the time the test starts refusing (the calendar, the formatted text, the review editor, the other
 * pages) answers as a file the deploy deleted (tests/prod/stale-chunk.spec.ts). With a fake microphone, in both ways of
 * recording, the recording is either stopped and saved as a file, or its page is left on purpose (Lämna sidan) towards
 * a page whose code is gone; it is found again after the person's own reload.
 *
 * Stopping and saving need none of those scripts: a refused request there is a finding, not something to filter out.
 * Leaving needs the next page's, and ends in the line and the reload button. Nothing reloads by itself.
 */
import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { test } from "../e2e/auth";
import ids from "../fixtures/ids.json";
import { removeChunksNotFetched, watchForReloads } from "./gone-chunks";

// Launch options belong to the whole file: Chromium's fake microphone, with its permission granted.
test.use({ permissions: ["microphone"], launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });

/** What "Spara som fil" gives: the recording's one part, as the browser's own audio file. */
async function savedFile(page: Page) {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 10_000 }), page.getByRole("button", { name: "Spara som fil" }).click()]);
  return { name: download.suggestedFilename(), bytes: await readFile((await download.path())!) };
}

/** The flow's page opened by its address, so no other page's code has been fetched, and a recording started on it. */
async function startRecording(page: Page, mode: "Spela in" | "Strömma") {
  await page.goto(`/flows/${ids.flows.flow1}`);
  await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
  await page.getByRole("radio", { name: new RegExp(`^${mode}`) }).click();
  await page.getByRole("button", { name: mode === "Strömma" ? "Starta strömning" : "Starta inspelning" }).click();
  await expect(page.getByRole("button", { name: "Stoppa" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Spelar in." })).toBeAttached();
}

/** What the device holds by now: the sizes of the audio chunks the recorder has handed over, and the state of each recording. */
const onDevice = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ bytes: number; states: string[] }>((resolve, reject) => {
        const open = indexedDB.open("tal-till-text");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const chunks = db.transaction("chunks").objectStore("chunks").getAll();
          chunks.onsuccess = () => {
            const recordings = db.transaction("recordings").objectStore("recordings").getAll();
            recordings.onsuccess = () => {
              db.close();
              resolve({
                bytes: (chunks.result as { data: ArrayBuffer }[]).reduce((sum, chunk) => sum + chunk.data.byteLength, 0),
                states: (recordings.result as { state: string }[]).map((recording) => recording.state),
              });
            };
          };
        };
      }),
  );

for (const mode of ["Spela in", "Strömma"] as const) {
  test(`a recording is stopped and saved as a file, and stays on the device, with the code that was not fetched gone: ${mode} @chromium`, async ({ session, page }) => {
    expect(session.user).toBeTruthy();
    await startRecording(page, mode);

    const gone = await removeChunksNotFetched(page);
    const reloads = await watchForReloads(page);
    // Longer than the recorder's own two seconds, so that the recording has audio on the device and is not "very short".
    await page.waitForTimeout(3500);
    await page.getByRole("button", { name: "Stoppa" }).click();
    await expect(page.getByRole("heading", { name: "Inspelningen är klar" })).toBeVisible();
    await expect(page.getByText("Inspelningen finns kvar på enheten tills dokumentet är skapat.")).toBeVisible();

    const saved = await savedFile(page).catch((error) => {
      // A save that needs a script the page does not have gets no file: say which script, not that the file never came.
      expect(gone.refused, "stopping and saving needed no script that the page had not fetched").toEqual([]);
      throw error;
    });
    expect(saved.name).toMatch(/^inspelning-.*\.webm$/);
    expect(saved.bytes.length, "a recording of some seconds").toBeGreaterThan(5000);
    expect(saved.bytes.subarray(0, 4).toString("hex"), "a WebM file").toBe("1a45dfa3");
    expect(gone.refused, "stopping and saving needed no script that the page had not fetched").toEqual([]);
    expect(await reloads.stillTheSameTab(), "nothing reloaded the page by itself").toBe(true);

    // The person leaves and comes back: the browser asks first, and the recording is among those not yet sent.
    page.on("dialog", (dialog) => void dialog.accept());
    await page.reload();
    await expect(page.getByRole("heading", { name: "En inspelning har inte skickats" })).toBeVisible();
    const again = await savedFile(page);
    expect(again.name).toBe(saved.name);
    expect(again.bytes.equals(saved.bytes), "the same audio, byte for byte").toBe(true);
  });
}

for (const mode of ["Spela in", "Strömma"] as const) {
  test(`a recording whose page is left on purpose, towards a page whose code is gone, stays on the device: ${mode} @chromium`, async ({ session, page }) => {
    expect(session.user).toBeTruthy();
    await startRecording(page, mode);
    const gone = await removeChunksNotFetched(page);
    const reloads = await watchForReloads(page);
    await page.waitForTimeout(3500);

    const { bytes: stored, states } = await onDevice(page);
    expect(stored, "the recorder has handed audio over to the device by now").toBeGreaterThan(0);
    expect(states).toEqual(["recording"]);

    // The page's own way to the list, and the page's own question: leaving stops the recording and promises it back.
    await page.getByRole("link", { name: "Alla flöden" }).filter({ visible: true }).first().click();
    const question = page.getByRole("alertdialog", { name: "Lämna sidan?" });
    await expect(question).toContainText("Det som spelats in finns kvar bland osända inspelningar.");
    await question.getByRole("button", { name: "Lämna sidan" }).click();

    // The list's code is gone: its page is replaced by the line and the reload, and nothing reloads by itself.
    await expect(page.getByRole("heading", { name: "Sidan kunde inte visas." })).toBeVisible();
    expect(gone.refused.map((path) => path.replace(/-[^-/]+\.js$/, "")), "the list's code was asked for and refused").toEqual(["/assets/FlowsPage"]);
    expect(await reloads.stillTheSameTab(), "nothing reloaded the page by itself").toBe(true);
    // Paused, as the question said: the recording stopped with its page and waits to be recovered, sent or saved.
    await expect.poll(async () => (await onDevice(page)).states, "the recording is kept, paused").toEqual(["paused"]);

    // The deploy's new files are there by the time the person presses.
    await page.unrouteAll();
    page.on("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Ladda om sidan" }).click();
    await expect(page.getByRole("heading", { name: "En inspelning har inte skickats" })).toBeVisible();
    const seconds = Number((await page.getByText(/Nämndmöte till rapport · \d+ s/).textContent())!.match(/· (\d+) s/)![1]);
    expect(seconds, "what was recorded up to the leave, not only the audio that had been handed over before it").toBeGreaterThanOrEqual(3);
    const saved = await savedFile(page);
    expect(saved.bytes.length, "nothing the device held before the leave is missing from the file").toBeGreaterThanOrEqual(stored);
    expect(saved.name).toMatch(/^inspelning-.*\.webm$/);
    expect(saved.bytes.subarray(0, 4).toString("hex"), "a WebM file").toBe("1a45dfa3");

    // Still there, and the same, at the next reload; and the flow's page offers to go on with it.
    await page.reload();
    await expect(page.getByRole("heading", { name: "En inspelning har inte skickats" })).toBeVisible();
    const again = await savedFile(page);
    expect(again.bytes.equals(saved.bytes), "the same audio, byte for byte").toBe(true);
    await page.getByRole("link", { name: /Nämndmöte till rapport/ }).click();
    // Its own page says it was cut off, not that it is one of the unsent (the list's words, which the list is still showing
    // until the router has moved): neither heading is on both pages, so this waits for the flow's page.
    await expect(page.getByRole("heading", { name: "Inspelningen avbröts" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Fortsätt spela in" })).toBeVisible();
  });
}
