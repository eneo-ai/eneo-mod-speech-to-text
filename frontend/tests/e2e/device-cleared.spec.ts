/**
 * The browser's data is cleared while a recording runs (the person clears site data, or the browser takes the storage
 * back): the recording is said to be kept in this tab only, at once, goes on, and what is kept can be saved as a file and
 * sent. The audio before the clearing is gone with the device's copy.
 */
import { expect, test } from "./gate";
import { record, setup, stop } from "./screens";

test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1440-light", "storage, at one width"));

test("clearing the site's data mid-recording is said at once, and Spara som fil saves what is kept", async ({ page, context, baseURL }) => {
  await setup(page);
  await record(page, "Spela in");
  await page.waitForTimeout(2_500);
  const devtools = await context.newCDPSession(page);
  await devtools.send("Storage.clearDataForOrigin", { origin: new URL(baseURL!).origin, storageTypes: "indexeddb" });
  // The alert, not the end of the meeting, says it: the page has no way to know more than the device does.
  await expect(page.getByText("Inspelningen kan inte längre sparas på enheten.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Stoppa" })).toBeVisible();
  await page.waitForTimeout(2_500);
  await stop(page);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Spara som fil" }).click();
  const chunks: Buffer[] = [];
  for await (const chunk of await (await download).createReadStream()) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks).length, "a file with audio in it").toBeGreaterThan(1_000);
});

test("after the data was cleared mid-recording, Skapa dokument sends what is kept", async ({ page, context, baseURL }) => {
  await setup(page);
  await record(page, "Spela in");
  await page.waitForTimeout(2_500);
  await (await context.newCDPSession(page)).send("Storage.clearDataForOrigin", { origin: new URL(baseURL!).origin, storageTypes: "indexeddb" });
  await expect(page.getByText("Inspelningen kan inte längre sparas på enheten.")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2_500);
  await stop(page);
  await page.getByRole("button", { name: "Skapa dokument" }).click();
  await page.waitForURL(/[?&]run=/);
});
