/**
 * A deployment while someone records: the page holds audio that no one else has. Every script of the build that the page
 * has not fetched by the time the test starts refusing (the calendar, the formatted text, the review editor, the other
 * pages) answers as a file the deploy deleted (tests/prod/stale-chunk.spec.ts), and the recording is stopped, saved as a
 * file and found again after the person's own reload, with a fake microphone, in both ways of recording.
 *
 * The page does not need one of those scripts to stop or keep a recording: a refused request here is a finding, not
 * something to filter out. Nothing reloads by itself.
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

for (const mode of ["Spela in", "Strömma"] as const) {
  test(`a recording is stopped and saved as a file, and stays on the device, with the code that was not fetched gone: ${mode} @chromium`, async ({ session, page }) => {
    expect(session.user).toBeTruthy();
    await page.goto(`/flows/${ids.flows.flow1}`);
    await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" })).toBeVisible();
    await page.getByRole("radio", { name: new RegExp(`^${mode}`) }).click();
    await page.getByRole("button", { name: mode === "Strömma" ? "Starta strömning" : "Starta inspelning" }).click();
    await expect(page.getByRole("button", { name: "Stoppa" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Spelar in." })).toBeAttached();

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
