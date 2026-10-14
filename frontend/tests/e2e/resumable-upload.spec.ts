/**
 * A real page sends several bounded parts and recovers after the server committed a part but its reply was lost, and a
 * recording's send cut off by a reload goes on after it where the module has it.
 */
import type { Page } from "@playwright/test";
import ids from "../fixtures/ids.json";
import { expect, test } from "./gate";
import { chooseMode, setup, wav } from "./screens";
import { declare } from "./sentinel";

const PIECE = 4 * 1024 * 1024;

test.beforeEach(({}, info) => test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "one laptop and one phone"));

test("a large file resumes after a lost part reply, then starts one run", async ({ page }) => {
  declare(page, [{ console: /net::ERR_FAILED.*\/api\/uploads\// }, { requestFailed: /PATCH .*\/api\/uploads\/.*net::ERR_FAILED/ }]);
  const offsets: number[] = [];
  const resources = new Set<string>();
  let dropped = false;
  let runs = 0;
  await page.route(/\/api\/uploads\//, async (route) => {
    const request = route.request();
    resources.add(request.url().replace(/\/complete$/, ""));
    if (request.method() !== "PATCH") return route.fallback();
    offsets.push(Number(request.headers()["upload-offset"]));
    if (!dropped) {
      dropped = true;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await response.dispose();
      return route.abort("failed");
    }
    return route.fallback();
  });
  await page.route(/\/flows\/[^/]+\/runs\/$/, (route) => {
    if (route.request().method() === "POST") runs += 1;
    return route.fallback();
  });
  await setup(page);
  await chooseMode(page, "Ladda upp");
  const audio = wav(280); // 4.48 MB: two parts, still below the flow's duration and file limits.
  expect(audio.length).toBeGreaterThan(4 * 1024 * 1024);
  await page.locator('input[type="file"]').setInputFiles({ name: "langt-mote.wav", mimeType: "audio/wav", buffer: audio });
  await expect(page.getByRole("button", { name: "Byt fil" })).toBeVisible();
  await page.getByRole("button", { name: "Skapa dokument" }).click();
  await page.waitForURL(/[?&]run=/);
  expect(offsets).toEqual([0, 4 * 1024 * 1024]);
  expect(resources.size).toBe(1);
  expect(runs).toBe(1);
});

/** A stopped recording of `bytes` bytes for flow 1, kept on this device as the recorder keeps one (lib/recording-store.ts). */
async function keptRecording(page: Page, bytes: number): Promise<string> {
  return page.evaluate(
    async ({ bytes, flowId, stepId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open("tal-till-text", 1);
        opening.onupgradeneeded = () => {
          opening.result.createObjectStore("recordings", { keyPath: "id" });
          opening.result.createObjectStore("chunks", { keyPath: ["recordingId", "part", "seq"] });
        };
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
      });
      const id = crypto.randomUUID();
      const startedAt = Date.now();
      const writing = db.transaction(["recordings", "chunks"], "readwrite");
      writing.objectStore("recordings").put({
        id, ownerId: "user-1", flowId, flowName: "Nämndmöte till rapport", stepId, inputMode: "record", mimeType: "audio/wav",
        startedAt, durationMs: 280_000, state: "stopped", runId: null,
        parts: [{ index: 0, startedAt, durationMs: 280_000, bytes, chunks: 1, fileId: null }],
      });
      writing.objectStore("chunks").put({ recordingId: id, part: 0, seq: 0, data: new ArrayBuffer(bytes) });
      await new Promise((resolve, reject) => {
        writing.oncomplete = resolve;
        writing.onerror = () => reject(writing.error);
      });
      db.close();
      return id;
    },
    { bytes, flowId: ids.flows.flow1, stepId: ids.steps.audio },
  );
}

test("a recording's send cut off by a reload goes on where the module has it, with the bar from there, and starts one run", async ({ page }) => {
  const size = PIECE + 300_000; // two pieces
  const asked: string[] = [];
  let pieceIn!: () => void;
  const firstPieceIn = new Promise<void>((resolve) => (pieceIn = resolve));
  let letGo!: () => void;
  const secondPieceMayGo = new Promise<void>((resolve) => (letGo = resolve));
  let runs = 0;
  await page.route(/\/api\/uploads\//, async (route) => {
    const request = route.request();
    const [id] = request.url().split("/api/uploads/")[1].split("/").slice(2);
    const offset = request.headers()["upload-offset"];
    asked.push([request.method(), id, offset].filter(Boolean).join(" "));
    if (request.method() !== "PATCH") return route.fallback();
    if (offset === "0") {
      // The module has the first piece; the page is reloaded before its answer arrives, so the request is left hanging.
      await (await route.fetch()).dispose();
      return pieceIn();
    }
    await secondPieceMayGo;
    return route.fallback();
  });
  await page.route(/\/flows\/[^/]+\/runs\/$/, (route) => {
    if (route.request().method() === "POST") runs += 1;
    return route.fallback();
  });
  await page.goto("/flows");
  const recording = await keptRecording(page, size);
  await page.goto(`/flows/${ids.flows.flow1}?recording=${recording}`);
  await firstPieceIn;
  page.on("dialog", (dialog) => void dialog.accept());
  await page.reload();

  // Every value the bar takes from here on.
  await page.evaluate(() => {
    const values: number[] = [];
    (window as unknown as { barValues: number[] }).barValues = values;
    new MutationObserver(() => {
      const value = document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow");
      if (value) values.push(Number(value));
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-valuenow"] });
  });
  await page.getByRole("button", { name: "Skapa dokument av inspelningen" }).click();
  const where = Math.round((PIECE / size) * 100);
  await expect(page.getByRole("progressbar", { name: "Uppladdning" })).toHaveAttribute("aria-valuenow", String(where));
  letGo();
  await page.waitForURL(/[?&]run=/);
  const barValues = await page.evaluate(() => (window as unknown as { barValues: number[] }).barValues);
  expect(Math.min(...barValues), `the values the bar took: ${barValues.join(", ")}`).toBe(where);
  const [, id] = asked[0].split(" ");
  // The module's own status reads while it hands the file on are not counted: the stub answers at once, the backend polls.
  expect(asked.filter((request) => !request.startsWith("GET "))).toEqual([`PUT ${id}`, `PATCH ${id} 0`, `PUT ${id}`, `PATCH ${id} ${PIECE}`, `POST ${id}`]);
  expect(runs).toBe(1);
});
