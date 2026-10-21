import assert from "node:assert/strict";
import test, { afterEach, type TestContext } from "node:test";
import { createElement } from "react";

import { button, cleanup, installDom, mount } from "./test-dom";

installDom();
afterEach(cleanup);

/** A microphone's track that says when it is let go, and is muted, comes back or ends as a real one does. */
function fakeStream() {
  const listeners: Record<string, (() => void)[]> = {};
  const track = {
    kind: "audio",
    muted: false,
    stopped: false,
    stop() {
      this.stopped = true;
    },
    addEventListener: (type: string, listener: () => void) => void (listeners[type] ??= []).push(listener),
    fire(type: "ended" | "mute" | "unmute") {
      if (type === "mute" || type === "unmute") track.muted = type === "mute";
      (listeners[type] ?? []).forEach((listener) => listener());
    },
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

/** What the page's level meter reads: the loudest sample of each read, as the test sets it. */
function useLevel(t: TestContext) {
  const level = { peak: 0 };
  class FakeAudioContext extends (window as unknown as { EventTarget: typeof EventTarget }).EventTarget {
    state = "running";
    resume = async () => undefined;
    close = async () => undefined;
    createMediaStreamSource = () => ({ connect: () => undefined, disconnect: () => undefined });
    createAnalyser = () => ({ fftSize: 0, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(level.peak) });
  }
  const page = window as unknown as { AudioContext?: unknown };
  const browserAudio = page.AudioContext;
  page.AudioContext = FakeAudioContext;
  t.after(() => void (page.AudioContext = browserAudio));
  t.mock.timers.enable({ apis: ["setInterval"] });
  return level;
}

/** The browser's question about the microphone, answered when the test says so; `inputs` are the devices it lists. */
function useMicrophone(t: TestContext, inputs: Partial<MediaDeviceInfo>[] = []) {
  let answer: (stream: MediaStream) => void = () => {};
  let asked = 0;
  const devices = {
    getUserMedia: () => {
      asked += 1;
      return new Promise<MediaStream>((resolve) => (answer = resolve));
    },
    enumerateDevices: async () => inputs,
    addEventListener() {},
    removeEventListener() {},
  };
  const original = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", { value: devices, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(navigator, "mediaDevices", original);
    else Reflect.deleteProperty(navigator, "mediaDevices");
  });
  return { answer: (stream: MediaStream) => answer(stream), asked: () => asked };
}

async function microphoneCheck() {
  const { MicrophoneCheck } = await import("../components/flow/MicrophoneCheck");
  const view = await mount(createElement(MicrophoneCheck, { active: true }));
  const press = (name: string) => view.act(async () => button(view.container, name)!.click());
  const text = () => view.container.textContent ?? "";
  return { ...view, press, text, offers: (name: string) => button(view.container, name) !== null };
}

test("before a test the page says what the test does with the sound, and while the browser asks the test can be stopped", async (t) => {
  const microphone = useMicrophone(t);
  const view = await microphoneCheck();
  assert.match(view.text(), /Testa mikrofonen före mötet\. Testet spelas inte in och skickas inte\./);
  // The line the test will speak on has its words from the first draw, so nothing appears or moves when it starts.
  assert.match(view.text(), /Testet visar här om mikrofonen hör dig\./);

  await view.press("Testa mikrofonen");
  assert.ok(view.offers("Sluta testa"), "the question is under way: the test can be stopped");
  await view.press("Sluta testa");
  assert.ok(view.offers("Testa mikrofonen"));
  assert.equal(microphone.asked(), 1);

  // The browser answers after all: the microphone it gives is let go at once.
  const late = fakeStream();
  await view.act(async () => microphone.answer(late.stream));
  assert.equal(late.track.stopped, true);
  assert.ok(view.offers("Testa mikrofonen"));
});

test("the picker says the same with one microphone or many, so nothing under it moves when the browser names them", async (t) => {
  const mic = (deviceId: string, label: string) => ({ kind: "audioinput" as const, deviceId, groupId: deviceId, label });
  const description = (text: string) => /Mikrofon(.*?)Standard/.exec(text)?.[1];
  useMicrophone(t, [mic("built-in", "Inbyggd mikrofon"), mic("table", "Konferensmikrofon")]);
  const two = await microphoneCheck();
  await two.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const many = description(two.text());
  await two.unmount();

  useMicrophone(t, [mic("built-in", "Inbyggd mikrofon")]);
  const one = await microphoneCheck();
  await one.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(description(one.text()), many);
  assert.equal(many, "Testa mikrofonen före mötet. Testet spelas inte in och skickas inte.");
});

test("a long wait for the browser's answer says where the question is, and a quick one says nothing", async (t) => {
  useMicrophone(t);
  const view = await microphoneCheck();
  await view.press("Testa mikrofonen");
  assert.doesNotMatch(view.text(), /Svara på frågan i webbläsaren\./, "not at once: a quick answer leaves no blink");
  await view.act(() => new Promise((done) => setTimeout(done, 400)));
  assert.match(view.text(), /Svara på frågan i webbläsaren\./);
});

test("a microphone that ends, ends the test", async (t) => {
  const microphone = useMicrophone(t);
  const view = await microphoneCheck();
  await view.press("Testa mikrofonen");
  const given = fakeStream();
  await view.act(async () => microphone.answer(given.stream));
  assert.ok(view.offers("Sluta testa"));

  await view.act(async () => given.track.fire("ended"));
  assert.ok(view.offers("Testa mikrofonen"), "the microphone is gone: nothing the test said holds");
  assert.match(view.text(), /Testet spelas inte in och skickas inte\./);
  assert.doesNotMatch(view.text(), /Mikrofonen hörde/);
});

test("a test that is stopped says what the microphone heard", async (t) => {
  const microphone = useMicrophone(t);
  const level = useLevel(t);
  const view = await microphoneCheck();
  const run = async (peak: number) => {
    await view.press("Testa mikrofonen");
    const given = fakeStream();
    await view.act(async () => microphone.answer(given.stream));
    level.peak = peak;
    await view.act(async () => t.mock.timers.tick(500));
    await view.press("Sluta testa");
    assert.equal(given.track.stopped, true);
  };

  await run(0.6);
  assert.match(view.text(), /Mikrofonen hörde dig\./);
  await run(0);
  assert.match(view.text(), /Mikrofonen hörde inget\./);
  assert.doesNotMatch(view.text(), /Mikrofonen hörde dig\./, "a new test says only what it heard itself");
});

test("the test lets the microphone go by itself after a minute, and when the page is hidden", async (t) => {
  const microphone = useMicrophone(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const view = await microphoneCheck();

  await view.press("Testa mikrofonen");
  const first = fakeStream();
  await view.act(async () => microphone.answer(first.stream));
  await view.act(async () => t.mock.timers.tick(59_000));
  assert.equal(first.track.stopped, false);
  await view.act(async () => t.mock.timers.tick(1_000));
  assert.equal(first.track.stopped, true, "the browser's microphone light goes out without Sluta testa");
  assert.ok(view.offers("Testa mikrofonen"));

  await view.press("Testa mikrofonen");
  const second = fakeStream();
  await view.act(async () => microphone.answer(second.stream));
  Object.defineProperty(document, "hidden", { value: true, configurable: true });
  t.after(() => Reflect.deleteProperty(document, "hidden"));
  await view.act(async () => document.dispatchEvent(new window.Event("visibilitychange")));
  assert.equal(second.track.stopped, true, "another tab or the home screen: the test ends");
});

test("a microphone that goes quiet while it is tested no longer says it hears you, and says so", async (t) => {
  const microphone = useMicrophone(t);
  const level = useLevel(t);
  const view = await microphoneCheck();
  await view.press("Testa mikrofonen");
  const given = fakeStream();
  await view.act(async () => microphone.answer(given.stream));
  const listen = () => view.act(async () => t.mock.timers.tick(500));

  level.peak = 0.6;
  await listen();
  assert.match(view.text(), /Mikrofonen hör dig\./);

  level.peak = 0;
  await view.act(async () => given.track.fire("mute"));
  await listen();
  assert.doesNotMatch(view.text(), /Mikrofonen hör dig\./, "what it heard before is no longer so");
  assert.match(view.text(), /Mikrofonen är tillfälligt borta\./);

  await view.act(async () => given.track.fire("unmute"));
  assert.match(view.text(), /Säg något för att se att du hörs\./, "back, and not heard yet");
  level.peak = 0.6;
  await listen();
  assert.match(view.text(), /Mikrofonen hör dig\./);
});

test("after a moment muted, only new sound says the microphone hears you, not what it heard before", async (t) => {
  const microphone = useMicrophone(t);
  const level = useLevel(t);
  const view = await microphoneCheck();
  await view.press("Testa mikrofonen");
  const given = fakeStream();
  await view.act(async () => microphone.answer(given.stream));
  const read = () => view.act(async () => t.mock.timers.tick(66));

  level.peak = 0.6;
  await read();
  assert.match(view.text(), /Mikrofonen hör dig\./);
  // A brief mute: back at once, and then only silence.
  level.peak = 0;
  await view.act(async () => given.track.fire("mute"));
  await view.act(async () => given.track.fire("unmute"));
  await read();
  assert.doesNotMatch(view.text(), /Mikrofonen hör dig\./, "the meter still glows from before, but nothing new was heard");
  level.peak = 0.6;
  await read();
  assert.match(view.text(), /Mikrofonen hör dig\./);
});
