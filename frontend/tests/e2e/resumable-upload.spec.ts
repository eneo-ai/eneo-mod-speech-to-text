/**
 * A real page sends several bounded parts and recovers after the server committed a part but its reply was lost, and a
 * recording's send cut off by a reload goes on after it where the module has it.
 */
import ids from "../fixtures/ids.json";
import { expect, test } from "./gate";
import { chooseMode, keptRecording, needsRecording, setup, wav } from "./screens";
import { declare } from "./sentinel";

const PIECE = 4 * 1024 * 1024;

/** A part the module has and whose reply is lost is made by passing the request on and dropping the answer: WebKit's
 *  routes do not see a file's bytes (no post data for a Blob body), so the part would go on without them. */
const lostReplyNeedsBody = (browserName: string) =>
  test.skip(browserName === "webkit", "WebKit's routes cannot pass a file's bytes on, so a part the module has cannot be made here");

// One laptop and one phone, and the same in WebKit (an iPhone's engine) and Firefox: the upload is the engine's own request.
test.beforeEach(({}, info) =>
  test.skip(!["laptop-1440-light", "phone-390-light", "phone-390-webkit", "laptop-1440-firefox"].includes(info.project.name), "one laptop and one phone, in each engine"),
);

test("a large file resumes after a lost part reply, then starts one run", async ({ page, browserName }) => {
  lostReplyNeedsBody(browserName);
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

test("a recording's send cut off by a reload goes on where the module has it, with the bar from there, and starts one run", async ({ page, browserName }) => {
  needsRecording();
  lostReplyNeedsBody(browserName);
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

test("while a file goes up the tab's title says how far it has come, and stops saying it once the upload is done", async ({ page }) => {
  let pieceIn!: () => void;
  const firstPieceIn = new Promise<void>((resolve) => (pieceIn = resolve));
  let letGo!: () => void;
  const secondPieceMayGo = new Promise<void>((resolve) => (letGo = resolve));
  await page.route(/\/api\/uploads\//, async (route) => {
    const request = route.request();
    if (request.method() !== "PATCH") return route.fallback();
    if (request.headers()["upload-offset"] !== "0") await secondPieceMayGo;
    else pieceIn();
    return route.fallback();
  });
  await setup(page);
  await chooseMode(page, "Ladda upp");
  await page.locator('input[type="file"]').setInputFiles({ name: "langt-mote.wav", mimeType: "audio/wav", buffer: wav(280) });
  await expect(page.getByRole("button", { name: "Byt fil" })).toBeVisible();
  await page.getByRole("button", { name: "Skapa dokument" }).click();
  await firstPieceIn;
  await expect.poll(() => page.title(), { message: "the percent first, then the state" }).toMatch(/^\d+\s%\s·\sDokumentet skapas · Tal till text$/);
  await expect(page.getByRole("heading", { level: 1 }), "the heading keeps its words").toHaveText("Dokumentet skapas");
  letGo();
  await page.waitForURL(/[?&]run=/);
  await expect.poll(() => page.title()).not.toMatch(/%/);
});

test("Försök nu from the keyboard leaves the focus in the card, not on the page's body, as the try begins", async ({ page }) => {
  // Every send fails: the file's upload, or the run's start after it, waits to try again.
  declare(page, [{ console: /net::ERR_FAILED/ }, { requestFailed: /net::ERR_FAILED/ }]);
  await page.route(/\/api\/(uploads|eneo\/)/, (route) => (route.request().method() === "GET" ? route.fallback() : route.abort("failed")));
  await setup(page);
  await chooseMode(page, "Ladda upp");
  await page.locator('input[type="file"]').setInputFiles({ name: "mote.wav", mimeType: "audio/wav", buffer: wav(2) });
  await page.getByRole("button", { name: "Skapa dokument" }).click();
  const now = page.getByRole("button", { name: "Försök nu" });
  await expect(now).toBeVisible({ timeout: 15_000 });
  await now.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: /skapas$/ }), "the card's heading, where the person reads on").toBeFocused();
});
