import assert from "node:assert/strict";
import test from "node:test";

import { createOnlineStatus, type OnlineTarget } from "./online-status";
import { LiveTranscriber, liveSocketUrl, openLiveSocket, type LiveSocket } from "./live-transcriber";

class FakeSocket implements LiveSocket {
  binaryType = "blob";
  sent: Array<string | ArrayBuffer> = [];
  closedWith: number | null = null;
  // A relay that stops reading leaves every sent frame queued.
  stalled = false;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
    if (this.stalled && data instanceof ArrayBuffer) this.bufferedAmount += data.byteLength;
  }
  close(code = 1000) {
    this.closedWith = code;
  }
  // The relay's side.
  event(payload: object) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  ready() {
    this.event({ type: "ready", sample_rate: 16_000, max_seconds: 18_000 });
  }
  drop(code: number) {
    this.onclose?.({ code });
  }
  frames() {
    return this.sent.filter((data): data is ArrayBuffer => data instanceof ArrayBuffer);
  }
}

function fakeBrowser(onLine: boolean) {
  const target = Object.assign(new EventTarget(), { navigator: { onLine } });
  return {
    target: target as OnlineTarget,
    go(online: boolean) {
      target.navigator.onLine = online;
      target.dispatchEvent(new Event(online ? "online" : "offline"));
    },
  };
}

/** The page's login, as far as live text follows it: covered while signed out or someone else is signed in. */
function fakeLogin() {
  const listeners = new Set<() => void>();
  const login = {
    signedOut: false,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return { login, cover: (on: boolean) => ((login.signedOut = on), listeners.forEach((listener) => listener())) };
}

function setup(options: { online?: boolean; login?: ReturnType<typeof fakeLogin>["login"] } = {}) {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const browser = fakeBrowser(options.online ?? true);
  const live = new LiveTranscriber({
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => void ((timer as { cleared: boolean }).cleared = true),
    online: createOnlineStatus(browser.target),
    login: options.login,
  });
  /** Runs the timers that would fire within `ms`. */
  const elapse = (ms: number) => {
    for (const timer of [...timers]) {
      if (!timer.cleared && timer.ms <= ms) {
        timer.cleared = true;
        timer.fn();
      }
    }
  };
  return { live, sockets, elapse, browser };
}

const frame = (byte: number) => new Uint8Array(3_200).fill(byte).buffer;
const firstByte = (data: ArrayBuffer) => new Uint8Array(data)[0];

test("frames from the moment recording starts wait for ready, then go in order; none while paused", () => {
  const { live, sockets } = setup();
  live.start();
  assert.equal(live.getSnapshot().status, "connecting");
  assert.equal(sockets[0].binaryType, "arraybuffer");
  live.pushFrame(frame(1));
  live.pushFrame(frame(2));
  assert.deepEqual(sockets[0].sent, [], "nothing before ready");

  sockets[0].ready();
  assert.equal(live.getSnapshot().status, "live");
  live.pushFrame(frame(3));
  assert.deepEqual(sockets[0].frames().map(firstByte), [1, 2, 3], "the first words are not lost");

  live.setRecording(false);
  live.pushFrame(frame(4));
  live.setRecording(true);
  live.pushFrame(frame(5));
  assert.deepEqual(sockets[0].frames().map(firstByte), [1, 2, 3, 5], "paused audio is not sent");
});

test("the wait for ready keeps a bounded buffer: the newest audio, not unbounded memory", () => {
  const { live, sockets } = setup();
  live.start();
  for (let i = 0; i < 400; i += 1) live.pushFrame(frame(i % 256));
  sockets[0].ready();
  const sent = sockets[0].frames();
  assert.equal(sent.length, 300, "30 s of 100 ms frames");
  assert.equal(firstByte(sent[sent.length - 1]), 399 % 256);
});

test("words arrive as a draft and become pieces at a sentence's end or after a pause", () => {
  const { live, sockets, elapse } = setup();
  live.start();
  sockets[0].ready();
  sockets[0].event({ type: "transcript.delta", text: "Välkomna till" });
  sockets[0].event({ type: "transcript.delta", text: " nämndens möte." });
  assert.deepEqual(live.getSnapshot().pieces.map((piece) => piece.text), ["Välkomna till nämndens möte."]);
  assert.equal(live.getSnapshot().pending, "");

  sockets[0].event({ type: "transcript.delta", text: " Första punkten" });
  assert.equal(live.getSnapshot().pending, " Första punkten", "still arriving: not yet a piece");
  elapse(2_000);
  assert.deepEqual(live.getSnapshot().pieces.map((piece) => piece.text), ["Välkomna till nämndens möte.", "Första punkten"]);
  assert.equal(live.getSnapshot().pending, "");
});

test("stop sends the last audio, then the stop message, keeps the draft and ends the session", () => {
  const { live, sockets } = setup();
  live.start();
  sockets[0].ready();
  live.pushFrame(frame(7));
  sockets[0].event({ type: "transcript.delta", text: "Tack för i dag" });
  live.stop();
  assert.deepEqual(sockets[0].sent.at(-1), JSON.stringify({ type: "stop" }));
  assert.deepEqual(live.getSnapshot().pieces.map((piece) => piece.text), ["Tack för i dag"]);
  sockets[0].event({ type: "transcript.done", text: "Tack för i dag." });
  sockets[0].drop(1000);
  assert.equal(live.getSnapshot().status, "ended");
  live.pushFrame(frame(8));
  assert.equal(sockets[0].frames().length, 1, "nothing after stop");
});

test("a refused start makes live text unavailable, and a refused handshake (1006) too", () => {
  const refused = setup();
  refused.live.start();
  refused.sockets[0].event({
    type: "error",
    code: "flow_live_transcription_unavailable",
    message: "Live transcription is not available for this flow.",
    retryable: false,
  });
  refused.sockets[0].drop(1000);
  assert.equal(refused.live.getSnapshot().status, "unavailable");
  refused.live.pushFrame(frame(1));
  assert.equal(refused.sockets.length, 1, "no second try for a refusal");

  const signedOut = setup();
  signedOut.live.start();
  signedOut.sockets[0].drop(1006);
  assert.equal(signedOut.live.getSnapshot().status, "unavailable");
});

test("a break after ready pauses live text and tries again with a new session; the draft continues", () => {
  const { live, sockets, elapse } = setup();
  live.start();
  sockets[0].ready();
  sockets[0].event({ type: "transcript.delta", text: "Budgeten för nästa år." });
  sockets[0].drop(1011); // Eneo's socket broke
  assert.equal(live.getSnapshot().status, "reconnecting");
  live.pushFrame(frame(9));

  elapse(1_000);
  assert.equal(sockets.length, 2, "a new session after the backoff");
  sockets[1].ready();
  assert.equal(live.getSnapshot().status, "live");
  assert.deepEqual(sockets[1].frames().map(firstByte), [9], "audio from the break is sent once ready");
  sockets[1].event({ type: "transcript.delta", text: " Ramen höjs." });
  assert.deepEqual(live.getSnapshot().pieces.map((piece) => piece.text), ["Budgeten för nästa år.", "Ramen höjs."]);

  // A retryable error pauses too; one that is not ends live text for this recording.
  sockets[1].event({ type: "error", code: "upstream_unreachable", message: "Eneo could not be reached.", retryable: true });
  sockets[1].drop(1000);
  assert.equal(live.getSnapshot().status, "reconnecting");
  elapse(2_000);
  sockets[2].ready();
  sockets[2].event({ type: "error", code: "duration_exceeded", message: "Too long.", retryable: false });
  sockets[2].drop(1000);
  assert.equal(live.getSnapshot().status, "stopped");
  elapse(60_000);
  assert.equal(sockets.length, 3, "no more tries");
  assert.equal(live.getSnapshot().pieces.length, 2, "the draft stays");
});

test("signed out mid-way: every refused handshake is tried again with the backoff, and live text resumes after the new login", () => {
  const { live, sockets, elapse } = setup();
  live.start();
  sockets[0].ready();
  sockets[0].event({ type: "transcript.delta", text: "Budgeten för nästa år." });
  sockets[0].drop(1006); // the login ended: the relay refuses the socket from here
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    elapse(30_000);
    sockets[attempt].drop(1006); // still signed out: refused before ready
    assert.equal(live.getSnapshot().status, "reconnecting", `never given up while recording (${attempt})`);
  }
  elapse(30_000); // signed in again: the next try is accepted
  sockets[6].ready();
  assert.equal(live.getSnapshot().status, "live");
  assert.deepEqual(live.getSnapshot().pieces.map((piece) => piece.text), ["Budgeten för nästa år."], "the draft stays");
});

test("offline, live text waits for the connection and starts again when it returns", () => {
  const { live, sockets, browser } = setup({ online: false });
  live.start();
  sockets[0].drop(1006);
  assert.equal(live.getSnapshot().status, "reconnecting", "not a refusal while offline");
  browser.go(true);
  assert.equal(sockets.length, 2, "at once when the connection is back");
});

test("a long pause may end the session for silence; live text starts again when recording goes on", () => {
  const { live, sockets } = setup();
  live.start();
  sockets[0].ready();
  live.setRecording(false);
  sockets[0].event({ type: "error", code: "idle_timeout", message: "No audio arrived in time.", retryable: false });
  sockets[0].drop(1000);
  assert.equal(live.getSnapshot().status, "reconnecting");
  assert.equal(sockets.length, 1, "no new session while paused");
  live.setRecording(true);
  assert.equal(sockets.length, 2);
});

test("the socket is the page's own origin, with no subprotocol", () => {
  assert.equal(
    liveSocketUrl({ protocol: "https:", host: "taltilltext.sundsvall.se" }, "flow-1", "step-a"),
    "wss://taltilltext.sundsvall.se/api/live/flow-1/step-a",
  );
  assert.equal(liveSocketUrl({ protocol: "http:", host: "127.0.0.1:3002" }, "f", "s"), "ws://127.0.0.1:3002/api/live/f/s");
  const calls: unknown[][] = [];
  class Recorder {
    constructor(...args: unknown[]) {
      calls.push(args);
    }
  }
  openLiveSocket(Recorder as unknown as typeof WebSocket, "wss://x/api/live/f/s");
  assert.deepEqual(calls, [["wss://x/api/live/f/s"]], "a browser fails a handshake that offered a subprotocol");
});

test("a connection coming back while a reconnect is under way opens no second socket, and dispose closes the one there is", () => {
  const { live, sockets, elapse, browser } = setup();
  live.start();
  sockets[0].ready();
  sockets[0].drop(1011);
  elapse(1_000);
  assert.equal(sockets.length, 2, "the reconnect, not ready yet");
  browser.go(false);
  browser.go(true);
  assert.equal(sockets.length, 2, "one connection at a time");
  live.dispose();
  assert.equal(sockets[1].closedWith, 1000, "no socket is left open");
});

test("a connection that stops draining is retired; no replacement opens before its close, and the wait stays bounded", () => {
  const { live, sockets, elapse, browser } = setup();
  live.start();
  sockets[0].ready();
  sockets[0].stalled = true;
  for (let i = 0; i < 1_000; i += 1) live.pushFrame(frame(i % 256));
  assert.equal(sockets[0].closedWith, 1000, "the stalled connection is asked to close");
  assert.equal(live.getSnapshot().status, "reconnecting");
  assert.ok(sockets[0].bufferedAmount <= 960_000, `at most 30 s queued, was ${sockets[0].bufferedAmount} bytes`);
  const sentBefore = sockets[0].frames().length;
  // While it closes, its queue drains, but nothing new may join it.
  sockets[0].stalled = false;
  sockets[0].bufferedAmount = 0;

  // The browser takes its time to close it: every chance to try again passes, and audio keeps coming.
  for (let round = 0; round < 4; round += 1) {
    elapse(60_000);
    browser.go(false);
    browser.go(true);
    live.setRecording(false);
    live.setRecording(true);
    for (let i = 0; i < 1_000; i += 1) live.pushFrame(frame(i % 256));
  }
  assert.equal(sockets.length, 1, "no replacement while the retired connection is still closing");
  assert.equal(sockets[0].frames().length, sentBefore, "nothing more is sent to it");

  sockets[0].drop(1000); // now it has closed
  elapse(1_000);
  assert.equal(sockets.length, 2, "a new session after the close");
  sockets[1].ready();
  const sent = sockets[1].frames();
  assert.equal(sent.length, 300, "the newest 30 s waited for it");
  assert.equal(firstByte(sent[sent.length - 1]), 999 % 256);
  assert.equal(live.getSnapshot().status, "live");
});

test("a socket the browser will not even open makes live text unavailable instead of throwing", () => {
  const live = new LiveTranscriber({
    openSocket: () => {
      throw new DOMException("The URL's scheme is not allowed.", "SyntaxError");
    },
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
  live.start();
  assert.equal(live.getSnapshot().status, "unavailable");
});

test("covered for a new login, live text sends nothing and opens no connection; the page's own user back, it goes on", () => {
  const { login, cover } = fakeLogin();
  const { live, sockets, elapse } = setup({ login });
  live.start();
  sockets[0].ready();
  live.pushFrame(new Uint8Array([1]).buffer);
  assert.equal(sockets[0].frames().length, 1);

  cover(true); // the login ended, or someone else signed in: the cookie is not the page's user's any more
  assert.equal(sockets[0].closedWith, 1000, "the connection closes");
  live.pushFrame(new Uint8Array([2]).buffer);
  sockets[0].drop(1000); // the browser's close
  elapse(60_000);
  assert.equal(sockets.length, 1, "no connection while covered, whatever the backoff says");
  assert.deepEqual(sockets[0].frames().map((frame) => new Uint8Array(frame)[0]), [1], "and no audio sent after the cover");
  assert.equal(live.getSnapshot().status, "reconnecting", "live text waits; the recording goes on");

  cover(false);
  assert.equal(sockets.length, 2, "the page's own user is back");
  sockets[1].ready();
  assert.deepEqual(sockets[1].frames().map((frame) => new Uint8Array(frame)[0]), [2], "what was recorded meanwhile goes now");
});

test("covered before live text was ready, it waits too, and starts once the page's own user is back, with the audio kept", () => {
  const { login, cover } = fakeLogin();
  const { live, sockets, elapse } = setup({ login });
  live.start();
  live.pushFrame(new Uint8Array([7]).buffer); // before ready: kept for the session
  cover(true);
  assert.equal(sockets[0].closedWith, 1000);
  sockets[0].drop(1000);
  elapse(60_000);
  assert.equal(sockets.length, 1, "nothing opens while covered");
  assert.equal(live.getSnapshot().status, "reconnecting", "waiting, not given up");

  cover(false);
  assert.equal(sockets.length, 2);
  sockets[1].ready();
  assert.equal(live.getSnapshot().status, "live");
  assert.deepEqual(sockets[1].frames().map((frame) => new Uint8Array(frame)[0]), [7], "the audio from before the cover goes now");
});

test("paused while a new try waits, live text opens no connection until recording goes on", () => {
  const { live, sockets, elapse } = setup();
  live.start();
  sockets[0].ready();
  sockets[0].drop(1006); // a break: a new try is set for a second from now
  assert.equal(live.getSnapshot().status, "reconnecting");
  live.setRecording(false); // Pausa
  elapse(60_000);
  assert.equal(sockets.length, 1, "no connection while paused");
  live.setRecording(true);
  assert.equal(sockets.length, 2, "going on connects");
});

test("stopped while a new try waits, live text opens no connection", () => {
  const { live, sockets, elapse } = setup();
  live.start();
  sockets[0].ready();
  sockets[0].drop(1006);
  live.stop();
  elapse(60_000);
  assert.equal(sockets.length, 1);
});

test("the relay's final text is the draft's last word: it replaces what the session's deltas said", () => {
  const { live, sockets } = setup();
  live.start();
  sockets[0].ready();
  sockets[0].event({ type: "transcript.delta", text: "Hej" });
  live.stop();
  sockets[0].event({ type: "transcript.done", text: "Hej världen" });
  assert.deepEqual(live.getSnapshot().pieces.map((piece) => piece.text), ["Hej världen"]);
  assert.equal(live.getSnapshot().complete, true);
  assert.equal(live.getSnapshot().status, "ended");
});

test("a stop waits for the final text as long as the relay allows it, in the background", () => {
  const { live, sockets, elapse } = setup();
  live.start();
  sockets[0].ready();
  sockets[0].event({ type: "transcript.delta", text: "Budgeten" });
  live.stop();
  elapse(45_000); // the model server can take this long to finish
  assert.notEqual(live.getSnapshot().status, "ended", "still waiting for the last words");
  sockets[0].event({ type: "transcript.done", text: "Budgeten för nästa år." });
  assert.deepEqual(live.getSnapshot().pieces.map((piece) => piece.text), ["Budgeten för nästa år."]);
  assert.equal(live.getSnapshot().complete, true);

  const late = setup();
  late.live.start();
  late.sockets[0].ready();
  late.live.stop();
  late.elapse(60_000);
  assert.equal(late.live.getSnapshot().status, "ended");
  assert.equal(late.live.getSnapshot().complete, false, "no final text came: unfinished");
});

test("a connection that closes after the stop, before its final text, leaves the draft unfinished", () => {
  const { live, sockets } = setup();
  live.start();
  sockets[0].ready();
  sockets[0].event({ type: "transcript.delta", text: "Hej" });
  live.stop();
  sockets[0].drop(1000);
  assert.equal(live.getSnapshot().status, "ended");
  assert.equal(live.getSnapshot().complete, false);
  assert.deepEqual(live.getSnapshot().pieces.map((piece) => piece.text), ["Hej"], "what came is kept");
});

test("the final text replaces only its own session's words, not those of the sessions before a break", () => {
  const { live, sockets, elapse } = setup();
  live.start();
  sockets[0].ready();
  sockets[0].event({ type: "transcript.delta", text: "Första delen." });
  sockets[0].drop(1006);
  elapse(1_000);
  sockets[1].ready();
  sockets[1].event({ type: "transcript.delta", text: "Andra" });
  live.stop();
  sockets[1].event({ type: "transcript.done", text: "Andra delen." });
  assert.deepEqual(live.getSnapshot().pieces.map((piece) => piece.text), ["Första delen.", "Andra delen."]);
});

test("an empty final text says the session heard nothing: its words go, the sessions before a break keep theirs", () => {
  const { live, sockets, elapse } = setup();
  live.start();
  sockets[0].ready();
  sockets[0].event({ type: "transcript.delta", text: "Första delen." });
  sockets[0].drop(1006);
  elapse(1_000);
  sockets[1].ready();
  sockets[1].event({ type: "transcript.delta", text: "Provisional words." });
  live.stop();
  sockets[1].event({ type: "transcript.done", text: "" });
  assert.deepEqual(live.getSnapshot().pieces.map((piece) => piece.text), ["Första delen."]);
  assert.equal(live.getSnapshot().complete, true);
});

test("a final message without its text leaves the words as they came and the draft unfinished", () => {
  const { live, sockets } = setup();
  live.start();
  sockets[0].ready();
  sockets[0].event({ type: "transcript.delta", text: "Provisional words." });
  live.stop();
  sockets[0].event({ type: "transcript.done" });
  assert.equal(live.getSnapshot().status, "ended");
  assert.deepEqual(live.getSnapshot().pieces.map((piece) => piece.text), ["Provisional words."]);
  assert.equal(live.getSnapshot().complete, false);
});
