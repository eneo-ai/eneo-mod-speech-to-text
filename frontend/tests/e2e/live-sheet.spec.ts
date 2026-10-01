/**
 * Strömma's live text is read while it arrives, so its sheet is a stage of the window's height, however long the text
 * grows: the sheet scrolls inside itself above the recording bar that stays docked below it, follows the newest line
 * while the reader is at the end, and "Visa senaste" brings it back after a scroll up. A stage that grows with its text
 * pushes the newest line out of the window and the bar's controls with it, which only a long text shows.
 */
import { expect, test, type Page } from "@playwright/test";
import { record, setup } from "./screens";

// The narrow windows are where the stage is the page's own height; one laptop is the control.
test.beforeEach(({}, info) =>
  test.skip(!["phone-320-light", "phone-390-light", "zoom-200", "laptop-1440-light"].includes(info.project.name), "the narrow windows, and a laptop as the control"),
);

const WORDS = 400;
const SENTENCE = "Första punkten gäller budgeten för nästa år och ramen höjs med två procent medan förvaltningen återkommer med en plan i oktober.".split(" ");

/** The live relay, answering at once with a long text, so a minute of speech takes a few seconds. */
async function longLiveText(page: Page) {
  await page.routeWebSocket(/\/api\/live\//, (ws) => {
    const send = (message: object) => ws.send(JSON.stringify(message));
    send({ type: "ready", sample_rate: 16000, max_seconds: 18000 });
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= WORDS) return clearInterval(timer);
      send({ type: "transcript.delta", text: (sent ? " " : "") + SENTENCE[sent++ % SENTENCE.length] });
    }, 8);
    ws.onClose(() => clearInterval(timer));
    ws.onMessage((message) => {
      if (typeof message === "string" && JSON.parse(message).type === "stop") {
        send({ type: "transcript.done", text: "" });
        ws.close();
      }
    });
  });
}

const geometry = (page: Page) =>
  page.evaluate(() => {
    const log = document.querySelector<HTMLElement>('[role="log"]')!;
    const stop = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Stoppa")!;
    const [l, s] = [log.getBoundingClientRect(), stop.getBoundingClientRect()];
    return {
      words: (log.textContent ?? "").split(/\s+/).filter(Boolean).length,
      logBottom: Math.round(l.bottom),
      logHeight: Math.round(l.height),
      stopTop: Math.round(s.top),
      viewport: innerHeight,
      scrolls: log.scrollHeight > log.clientHeight + 2,
      fromEnd: Math.round(log.scrollHeight - log.clientHeight - log.scrollTop),
    };
  });

test("long live text scrolls inside its sheet above the recording bar, follows the newest line, and Visa senaste brings it back", async ({ page }) => {
  await longLiveText(page);
  await setup(page);
  await record(page, "Strömma");
  await expect.poll(async () => (await geometry(page)).words, { timeout: 30_000 }).toBeGreaterThanOrEqual(WORDS - 5);

  const long = await geometry(page);
  expect(long.logHeight, `the sheet is shorter than the window (${JSON.stringify(long)})`).toBeLessThan(long.viewport);
  expect(long.logBottom, `the sheet ends above the bar's controls (${JSON.stringify(long)})`).toBeLessThanOrEqual(long.stopTop + 1);
  expect(long.scrolls, "the text scrolls inside the sheet").toBe(true);
  expect(long.fromEnd, "the newest line is in view").toBeLessThan(4);

  // Scrolled up by hand: the sheet stops following and says how to come back.
  await page.getByRole("log", { name: "Preliminär text" }).evaluate((log) => void (log.scrollTop = 0));
  const latest = page.getByRole("button", { name: "Visa senaste" });
  await expect(latest).toBeVisible();
  await latest.click();
  await expect.poll(async () => (await geometry(page)).fromEnd, { message: "Visa senaste shows the newest line" }).toBeLessThan(4);
  await expect(latest).toBeHidden();
});
