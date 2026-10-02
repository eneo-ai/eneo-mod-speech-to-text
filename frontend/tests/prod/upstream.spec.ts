import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import { test } from "../e2e/auth";
import ids from "../fixtures/ids.json";

// The real backend in front of the fake Eneo (tests/e2e/stub-server.py), signed in through the real handshake: what the
// module does to a request on its way to Eneo and back, in every engine. Eneo's side is read from the stub, by the id of
// the recording or by the size of the answer, so the engines can run side by side on one stub.
const STUB = process.env.STUB_URL;
const FLOW = ids.flows.flow1;
const STEP = ids.steps.audio;
const RUN = ids.runs.done;
const AUDIO = `/api/eneo/flows/${FLOW}/runs/${RUN}/input-files/${ids.files.audioA}/audio`;
const ARTIFACT = `/api/eneo/flows/${FLOW}/runs/${RUN}/artifacts/${ids.files.pdf}/content`;
const UPLOAD = `/api/eneo/flows/${FLOW}/steps/${STEP}/runtime-files/`;
const KIB = 1024;

type LiveSession = { frames: number; bytes: number; subprotocols: string[]; origin: string | null };

async function stub(request: APIRequestContext, path: string) {
  if (!STUB) throw new Error("STUB_URL names the fake Eneo the backend was started against");
  const answer = await request.get(new URL(path, STUB).href);
  expect(answer.status()).toBe(200);
  return answer.json();
}

test("the flow list is Eneo's, through the backend's proxy", async ({ session, context }) => {
  const answer = await context.request.get("/api/eneo/flows/");

  expect(answer.status()).toBe(200);
  const listed = (await answer.json()).items.map((flow: { id: string }) => flow.id);
  expect(listed).toContain(ids.flows.flow1);
  expect(session.user).toBeTruthy();
});

test("a write names the page's user, and a read need not", async ({ session, context, page }) => {
  await page.goto("/health"); // a document of the module's own origin: the browser sets Origin on what it sends
  const write = (user?: string) =>
    page.evaluate(
      async ({ path, user }) => {
        const response = await fetch(path, { method: "POST", headers: user ? { "X-Expected-User": user } : {}, body: new FormData() });
        return { status: response.status, body: await response.text() };
      },
      { path: UPLOAD, user },
    );

  const unnamed = await write();
  expect(unnamed.status).toBe(409);
  expect(JSON.parse(unnamed.body).detail).toBe("user_changed");
  expect((await write("someone-else")).status).toBe(409);
  // The check comes first: a page that names its user gets as far as the body, which is empty.
  expect((await write(session.user)).status).not.toBe(409);
  expect((await context.request.get("/api/eneo/flows/")).status()).toBe(200);
  expect((await context.request.get("/api/eneo/flows/", { headers: { "X-Expected-User": "someone-else" } })).status()).toBe(409);
});

test("the audio streams as a range, and a range past its end is refused", async ({ session, context }) => {
  expect(session.user).toBeTruthy();
  const whole = await context.request.get(AUDIO);
  const length = (await whole.body()).length;
  const partial = await context.request.get(AUDIO, { headers: { Range: "bytes=0-99" } });

  expect(whole.status()).toBe(200);
  expect(whole.headers()["content-type"]).toBe("audio/wav");
  expect(length).toBeGreaterThan(100 * KIB);
  expect(partial.status()).toBe(206);
  expect(partial.headers()["content-range"]).toBe(`bytes 0-99/${length}`);
  expect((await partial.body()).length).toBe(100);
  expect((await context.request.get(AUDIO, { headers: { Range: "bytes=99999999-" } })).status()).toBe(416);
});

test("only the PDF opened inline may be framed, and only by this origin", async ({ session, context }) => {
  expect(session.user).toBeTruthy();
  const inline = await context.request.get(`${ARTIFACT}?disposition=inline`);
  const download = await context.request.get(`${ARTIFACT}?disposition=attachment`);

  expect(inline.status()).toBe(200);
  expect(inline.headers()["content-type"]).toBe("application/pdf");
  expect(inline.headers()["content-disposition"]).toMatch(/^inline/);
  expect(inline.headers()["x-frame-options"]).toBe("SAMEORIGIN");
  expect(inline.headers()["content-security-policy"]).toBe("frame-ancestors 'self'");
  expect(download.headers()["content-disposition"]).toMatch(/^attachment/);
  expect(download.headers()["x-frame-options"]).toBe("DENY");
});

test("the live socket relays a frame to Eneo, and a frame past 128 KiB closes it with 1009", async ({ session, page, request }) => {
  const recording = `rec-${randomUUID()}`;
  await page.goto("/health");
  const socket = await page.evaluateHandle(
    ({ path }) =>
      new Promise<WebSocket>((resolve, reject) => {
        const opened = new WebSocket(location.origin.replace(/^http/, "ws") + path);
        opened.onmessage = (event) => JSON.parse(event.data).type === "ready" && resolve(opened);
        opened.onclose = (event) => reject(new Error(`closed before ready: ${event.code} ${event.reason}`));
      }),
    { path: `/api/live/${FLOW}/${STEP}?recording_id=${recording}&expected_user=${encodeURIComponent(session.user)}` },
  );
  const seen = async (): Promise<LiveSession | undefined> => (await stub(request, "/__stub/stats")).live_sessions[recording];

  await socket.evaluate((opened, size) => opened.send(new Uint8Array(size)), 64 * KIB);
  await expect.poll(async () => (await seen())?.frames).toBe(1);
  const closed = socket.evaluate((opened) => new Promise<number>((resolve) => (opened.onclose = (event) => resolve(event.code))));
  await socket.evaluate((opened, size) => opened.send(new Uint8Array(size)), 128 * KIB + 1);

  expect(await closed).toBe(1009);
  expect(await seen()).toMatchObject({ frames: 1, bytes: 64 * KIB, origin: null });
  expect((await seen())?.subprotocols[0]).toBe("eneo-live.v1"); // the ticket the browser never saw is the second
});

test("an upload of a few MB reaches Eneo whole, and the answer is Eneo's", async ({ session, page, request }) => {
  const size = 4 * KIB * KIB + Math.floor(Math.random() * KIB);
  await page.goto("/health");

  const answer = await page.evaluate(
    async ({ path, user, size }) => {
      const body = new FormData();
      body.append("upload_file", new Blob([new Uint8Array(size)], { type: "audio/webm" }), "inspelning.webm");
      const response = await fetch(path, { method: "POST", headers: { "X-Expected-User": user }, body });
      return { status: response.status, body: await response.json() };
    },
    { path: UPLOAD, user: session.user, size },
  );

  expect(answer.status).toBe(201);
  // The stub names the file by the bytes it received, which is what makes this check independent of any other upload.
  const received = Number(String(answer.body.id).slice(-12));
  expect(received).toBeGreaterThanOrEqual(size);
  expect(received).toBeLessThan(size + KIB); // the part's own headers and boundaries, nothing more
  const record = (await stub(request, "/__log")).find((entry: { bytes_received: number }) => entry.bytes_received === received);
  expect(record.request_line).toBe(`POST /api/v1/flows/${FLOW}/steps/${STEP}/runtime-files/ HTTP/1.1`);
  expect(record.how).toMatch(/complete/);
});
