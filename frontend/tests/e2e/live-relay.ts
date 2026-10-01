/** The live relay, answering at once with a long text, so a minute of speech takes a few seconds. */
import type { Page } from "@playwright/test";

export const WORDS = 400;
const SENTENCE = "Första punkten gäller budgeten för nästa år och ramen höjs med två procent medan förvaltningen återkommer med en plan i oktober.".split(" ");

export async function longLiveText(page: Page) {
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
