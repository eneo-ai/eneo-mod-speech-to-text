/**
 * Spara ljudfil saves a whole recording in one press, as each engine saves a download the page makes: a recording in
 * parts as one zip of every part, from the device and from Eneo's copy after a run, failed or finished.
 */
import { readFile } from "node:fs/promises";
import ids from "../fixtures/ids.json";
import { unzipped } from "../../lib/test-zip";
import { expect, test } from "./gate";
import { keptRecording, STATES } from "./screens";

test.beforeEach(({}, info) =>
  test.skip(!["laptop-1440-light", "phone-390-webkit", "laptop-1440-firefox"].includes(info.project.name), "each engine once"),
);

test("a recording on the device in two parts is saved in one press, as one zip of both", async ({ page }) => {
  await page.goto("/flows");
  await keptRecording(page, 1_000, "stopped", undefined, 2);
  await page.reload();
  const card = page.getByRole("region", { name: "En inspelning har inte skickats" });
  const saving = page.waitForEvent("download");
  await card.getByRole("button", { name: "Spara 2 ljudfiler (zip)" }).click();
  const download = await saving;
  const name = download.suggestedFilename();
  expect(name).toMatch(/^inspelning-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/);
  const files = await unzipped(await readFile((await download.path())!));
  const base = name.replace(/\.zip$/, "");
  expect(files.map(([file]) => file)).toEqual([`${base}-del-1.wav`, `${base}-del-2.wav`]);
  expect(files.map(([, bytes]) => [bytes.length, bytes[0]])).toEqual([[1_000, 0], [1_000, 1]]);
});

for (const [state, run, what] of [["failure", ids.runs.failed, "failed"], ["result", ids.runs.done, "finished"]] as const) {
  test(`a ${what} run's recording in two parts is saved from Eneo in one press, as one zip of both`, async ({ page }, info) => {
    await STATES.find((each) => each.name === state)!.go(page, info);
    const saving = page.waitForEvent("download");
    await page.getByRole("button", { name: "Spara 2 ljudfiler (zip)" }).click();
    const download = await saving;
    expect(download.suggestedFilename()).toMatch(/\.zip$/);
    const files = await unzipped(await readFile((await download.path())!));
    const audio = async (file: string) =>
      (await page.request.get(`/api/eneo/flows/${ids.flows.flow1}/runs/${run}/input-files/${file}/audio`)).body();
    const parts = [await audio(ids.files.audioA), await audio(ids.files.audioB)];
    expect(files.map(([, bytes], at) => bytes.equals(parts[at])), "each part as the module serves it, in order").toEqual([true, true]);
  });
}
