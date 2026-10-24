import { expect, test } from "./gate";
import { isLaptop, playedFromWord, result, run, scrollWhilePlaying, STATES } from "./screens";
import ids from "../fixtures/ids.json";
import { type Locator } from "@playwright/test";

test("the correction actions leave room for the field's focus outline", async ({ page }, info) => {
  await STATES.find((state) => state.name === "result-correction-open")!.go(page, info);
  const field = page.getByRole("textbox", { name: /^Rätta/ });
  await expect(field).toBeFocused();
  const fieldBox = await field.boundingBox();
  const saveBox = await page.getByRole("button", { name: "Spara", exact: true }).boundingBox();
  expect(saveBox!.y - (fieldBox!.y + fieldBox!.height), "space between the field and Spara").toBeGreaterThanOrEqual(12);
});

/** Contrast of the rendered text, including translucent backgrounds over the enclosing passage and card. */
async function textContrast(target: Locator) {
  return target.evaluate((element) => {
    type Color = [number, number, number, number];
    const context = document.createElement("canvas").getContext("2d")!;
    const color = (value: string): Color => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = ([r, g, b, a]: Color, [R, G, B]: Color): Color => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
    const background = (node: Element | null): Color => {
      if (!node) return [255, 255, 255, 1];
      const own = color(getComputedStyle(node).backgroundColor);
      return own[3] === 1 ? own : over(own, background(node.parentElement));
    };
    const luminance = ([r, g, b]: Color) => {
      const channel = (v: number) => v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4;
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const bg = background(element);
    const fg = over(color(getComputedStyle(element).color), bg);
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return { foreground: fg.slice(0, 3), background: bg.slice(0, 3), ratio: (hi + 0.05) / (lo + 0.05) };
  });
}

/** The contrast of `target`'s own fill against what it is drawn on (WCAG 1.4.11 for a control's part). */
async function fillContrast(target: Locator) {
  return target.evaluate((element) => {
    type Color = [number, number, number, number];
    const context = document.createElement("canvas").getContext("2d")!;
    const color = (value: string): Color => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = ([r, g, b, a]: Color, [R, G, B]: Color): Color => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
    const background = (node: Element | null): Color => {
      if (!node) return [255, 255, 255, 1];
      const own = color(getComputedStyle(node).backgroundColor);
      return own[3] === 1 ? own : over(own, background(node.parentElement));
    };
    const luminance = ([r, g, b]: Color) => {
      const channel = (v: number) => v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4;
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ground = background(element.parentElement);
    const fill = over(color(getComputedStyle(element).backgroundColor), ground);
    const [hi, lo] = [luminance(fill), luminance(ground)].sort((a, b) => b - a);
    return { fill: fill.slice(0, 3), ground: ground.slice(0, 3), ratio: (hi + 0.05) / (lo + 0.05) };
  });
}

test("the position slider's track shows where the recording ends, at 3:1 on its card in both colour modes", async ({ page }, info) => {
  test.skip(!["phone-390-light", "phone-390-dark", "laptop-1440-light", "laptop-1440-dark"].includes(info.project.name));
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const track = page.locator("[data-docked-player] .astryx-slider-track");
  const pair = await fillContrast(track);
  expect(pair.ratio, `the unplayed track: ${JSON.stringify(pair)} (WCAG 1.4.11)`).toBeGreaterThanOrEqual(3);
});

test("every match of a search is marked by more than its tint, and apart from the current one (WCAG 1.4.1)", async ({ page }, info) => {
  test.skip(!["phone-390-light", "laptop-1440-light", "laptop-1440-dark"].includes(info.project.name));
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  await page.getByRole("textbox", { name: "Sök i transkriberingen" }).fill("punkten");
  const match = page.locator('[data-hit="match"]').first();
  const current = page.locator('[data-hit="current"]');
  await expect(match).toBeVisible();
  const look = (hit: Locator) => hit.evaluate((element) => {
    const style = getComputedStyle(element);
    return { line: style.textDecorationLine, style: style.textDecorationStyle, outline: style.outlineStyle };
  });
  const [other, chosen] = [await look(match), await look(current)];
  expect(other.line, "a match is underlined").toContain("underline");
  expect(other, "the current match looks different").not.toEqual(chosen);
});

test("a word in the result plays its audio from the word, also from a pause, and the highlight follows playback", async ({ page }, info) => {
  test.skip(!["phone-390-light", "laptop-1440-light", "laptop-1440-dark", "forced-colors"].includes(info.project.name));
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const audio = page.locator("audio").first();
  await expect(page.getByRole("button", { name: "Spela upp", exact: true })).toBeVisible();
  const word = page.locator("[data-word-start]").filter({ hasText: /^punkten$/ }).first();
  const start = Number(await word.getAttribute("data-word-start"));
  await word.click();
  await expect(page.getByRole("button", { name: "Pausa uppspelningen" })).toBeVisible();
  // From the word: not from the start of its sentence or of the recording.
  const time = () => audio.evaluate((element: HTMLAudioElement) => element.currentTime);
  await expect.poll(time).toBeGreaterThanOrEqual(start - 0.05);
  expect(await time(), "played on from the word").toBeLessThan(start + 1.5);
  await expect.poll(time).toBeGreaterThan(start + 0.7);
  await expect(word).not.toHaveAttribute("aria-current", "true");
  await expect(page.locator('[data-word-start][aria-current="true"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Pausa uppspelningen" }).click();
});

test("words timed without speakers play from the word clicked and light one after another as they are said", async ({ page }, info) => {
  test.skip(!["phone-390-light", "laptop-1440-light", "forced-colors"].includes(info.project.name));
  await run(page, ids.runs.timed);
  await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toBeVisible();
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const transcript = page.getByRole("list", { name: "Transkriberingen" });
  // No speaker is named: the flow did not identify them.
  await expect(transcript.getByText(/Talare|Okänd talare/)).toHaveCount(0);
  // Forced alignment found every word but one, which is marked to check.
  await expect(page.getByText(/1 ord kunde inte hittas i ljudet/)).toBeVisible();

  const audio = page.locator("audio").first();
  const word = transcript.locator("[data-word-start]").filter({ hasText: /^punkten$/ }).first();
  const start = Number(await word.getAttribute("data-word-start"));
  await word.click();
  const time = () => audio.evaluate((element: HTMLAudioElement) => element.currentTime);
  await expect.poll(time).toBeGreaterThanOrEqual(start - 0.05);
  expect(await time(), "played on from the word").toBeLessThan(start + 1.5);
  // The playhead moves word by word: each word lit is a later one, and one at a time.
  const seen: number[] = [];
  await expect
    .poll(async () => {
      const lit = transcript.locator('[data-word-start][aria-current="true"]');
      if ((await lit.count()) === 1) {
        const at = Number(await lit.getAttribute("data-word-start"));
        if (seen.at(-1) !== at) seen.push(at);
      }
      return seen.length;
    }, { intervals: [50] })
    .toBeGreaterThanOrEqual(3);
  expect(seen, "each word lit after the one before").toEqual([...seen].sort((a, b) => a - b));
  expect(seen[0]).toBeGreaterThanOrEqual(start);
  await page.getByRole("button", { name: "Pausa uppspelningen" }).click();
});

test("a search hit in the result remains distinct from the word at the playhead", async ({ page }, info) => {
  test.skip(!["phone-390-light", "laptop-1440-light", "laptop-1440-dark", "forced-colors"].includes(info.project.name));
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const lit = await playedFromWord(page);
  const word = page.locator(`[data-word-start="${await lit.getAttribute("data-word-start")}"]`).first();
  await page.getByRole("textbox", { name: "Sök i transkriberingen" }).fill("höjs");
  const hit = page.locator('[data-hit="current"]');
  await expect(hit).toContainText("höjs");
  await expect(page.getByRole("button", { name: "Föregående träff" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Nästa träff" })).toBeDisabled();
  await expect(page.locator('[data-word-start][aria-current="true"]')).toHaveCount(1);
  await expect(word).toHaveAttribute("aria-current", "true");
  if (info.project.name !== "forced-colors") {
    expect(await hit.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toEqual(await word.evaluate((element) => getComputedStyle(element).backgroundColor));
  }
  expect(await hit.evaluate((element) => getComputedStyle(element).textDecorationLine)).toContain("underline");
});

test("the active word and search hit have readable text in both color modes", async ({ page }, info) => {
  test.skip(!["phone-390-light", "phone-390-dark", "laptop-1440-light", "laptop-1440-dark"].includes(info.project.name));
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const word = await playedFromWord(page);
  await page.getByRole("textbox", { name: "Sök i transkriberingen" }).fill("höjs");
  for (const [name, target] of [["active word", word], ["search hit", page.locator('[data-hit="current"]')]] as const) {
    const pair = await textContrast(target);
    info.annotations.push({ type: "contrast", description: `${name}: ${JSON.stringify(pair)}` });
    expect(pair.ratio, `${name}: ${JSON.stringify(pair)} (WCAG 1.4.3)`).toBeGreaterThanOrEqual(4.5);
  }
});

test("turning a tablet while the recording plays moves the player above or under the text, and it plays on", async ({ page }, info) => {
  test.skip(info.project.name !== "tablet-portrait", "the player stands above the text upright and under it on its side (1024 px)");
  await result(page);
  await page.getByRole("tab", { name: "Transkribering" }).click();
  const audio = page.locator("audio").first();
  await page.getByRole("button", { name: "Spela upp", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pausa uppspelningen" })).toBeVisible();
  // A mark on the element itself: a new <audio> would not carry it.
  await audio.evaluate((element) => void ((element as unknown as { kept?: boolean }).kept = true));
  const time = () => audio.evaluate((element: HTMLAudioElement) => element.currentTime);
  const above = () => page.getByRole("region", { name: "Inspelning och transkribering" }).locator("[data-docked-player]").evaluate((player) => player.getAttribute("data-dock-edge") === "top");
  expect(await above(), "upright, above the text").toBe(true);
  for (const [size, top] of [[{ width: 1024, height: 768 }, false], [{ width: 768, height: 1024 }, true]] as const) {
    const before = await time();
    await page.setViewportSize(size);
    await expect.poll(above).toBe(top);
    expect(await audio.evaluate((element) => (element as unknown as { kept?: boolean }).kept === true), "the same audio element").toBe(true);
    await expect.poll(time, { message: "it plays on without another press" }).toBeGreaterThan(before + 0.3);
  }
  await page.getByRole("button", { name: "Pausa uppspelningen" }).click();
});

test("the way past the transcript appears on keyboard focus and reaches the player", async ({ page }, info) => {
  test.skip(!["phone-390-light", "phone-390-dark", "laptop-1440-light", "laptop-1440-dark"].includes(info.project.name));
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const skip = page.getByRole("link", { name: "Hoppa förbi transkriberingen" });
  expect(await skip.evaluate((link) => link.getBoundingClientRect().height)).toBe(1);
  const destination = await skip.getAttribute("href");
  const url = page.url();
  await page.getByRole("textbox", { name: "Sök i transkriberingen" }).focus();
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  expect(await skip.evaluate((link) => link.getBoundingClientRect().height)).toBeGreaterThanOrEqual(36);
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-docked-player]')).toBeFocused();
  expect(await page.evaluate(() => `#${document.activeElement?.id}`)).toBe(destination);
  expect(page.url()).toBe(url);
  expect(await skip.evaluate((link) => link.getBoundingClientRect().height)).toBe(1);
  await page.keyboard.press("Tab");
  expect(await page.locator('[data-docked-player]').evaluate((player) => player.contains(document.activeElement))).toBe(true);
});


test("skip controls are disabled only at the recording boundaries", async ({ page }, info) => {
  test.skip(info.project.use.viewport!.width < 640, "the compact player uses the position slider");
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const back = page.getByRole("button", { name: "Bakåt 10 sekunder" });
  const forward = page.getByRole("button", { name: "Framåt 10 sekunder" });
  const position = page.getByRole("slider", { name: "Position i inspelningen" });
  // The skips stand in the player's row where the player has 31 rem (TranscriptPlayer.module.css), not by the window's
  // width: a laptop's transcript beside the document can be narrower, and there the slider keeps the room instead.
  const room = await page
    .getByRole("region", { name: "Inspelning och transkribering" })
    .evaluate((player) => player.getBoundingClientRect().width / Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
  if (room < 31) {
    await expect(back).toBeHidden();
    await expect(forward).toBeHidden();
    const track = await position.evaluate((thumb) => thumb.closest(".astryx-slider-control")!.getBoundingClientRect().width);
    expect(track, "the slider keeps its room").toBeGreaterThanOrEqual(120);
    return;
  }
  await expect(back).toBeDisabled();
  await expect(forward).toBeEnabled();
  await expect(position).toHaveAttribute("aria-valuemax", "20");
  await position.focus();
  await page.keyboard.press("End");
  await expect(forward).toBeDisabled();
  await expect(back).toBeEnabled();
  await back.focus();
  await page.keyboard.press("Enter");
  await expect(forward).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect(back).toBeDisabled();
  await expect(position).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(forward).toBeFocused();
  await position.focus();
  await page.keyboard.press("Home");
  await expect(back).toBeDisabled();
  await expect(forward).toBeEnabled();
  await forward.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(forward).toBeDisabled();
  await expect(position).toBeFocused();
});

test("a speed is chosen in one step from the player's menu, and the audio plays at it", async ({ page }, info) => {
  test.skip(!["phone-390-light", "laptop-1440-light"].includes(info.project.name), "the speed's place on a phone and on a laptop");
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  await page.getByRole("button", { name: "Hastighet 1×" }).click();
  await page.getByRole("menuitemradio", { name: "0,75×" }).click();
  await expect(page.getByRole("button", { name: "Hastighet 0,75×" })).toBeVisible();
  expect(await page.locator("audio").first().evaluate((audio: HTMLAudioElement) => audio.playbackRate)).toBe(0.75);
});

test("the speed chosen is kept for the person: the result after a reload and the speaker review start at it", async ({ page }, info) => {
  test.skip(!["phone-390-light", "laptop-1440-light"].includes(info.project.name), "the speed's place on a phone and on a laptop");
  const speedOnTab = async () => {
    if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  };
  await result(page);
  await speedOnTab();
  await page.getByRole("button", { name: "Hastighet 1×" }).click();
  await page.getByRole("menuitemradio", { name: "1,5×" }).click();
  await expect(page.getByRole("button", { name: "Hastighet 1,5×" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Dokumentet är klart" })).toBeVisible();
  await speedOnTab();
  await expect(page.getByRole("button", { name: "Hastighet 1,5×" })).toBeVisible();
  expect(await page.locator("audio").first().evaluate((audio: HTMLAudioElement) => audio.playbackRate)).toBe(1.5);

  await STATES.find((s) => s.name === "review")!.go(page, info);
  await expect(page.getByRole("button", { name: "Hastighet 1,5×" })).toBeVisible();
});

test("the player's keys are said once where there is a keyboard to press them, in the line's own type, and not on a touch screen", async ({ page }, info) => {
  test.skip(!["phone-390-light", "laptop-1440-light"].includes(info.project.name), "a touch screen and a mouse");
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const keys = page.getByText(/^Tangenter: K spelar och pausar/);
  const play = page.getByRole("button", { name: "Spela upp", exact: true });
  if (info.project.use.hasTouch) {
    await expect(keys).toHaveCount(0);
    await expect(play, "a key that does nothing is named nowhere").not.toHaveAttribute("aria-keyshortcuts");
    return;
  }
  await expect(keys).toBeVisible();
  await expect(play).toHaveAttribute("aria-keyshortcuts", "K");
  // Its Stäng av ends the line as a link ends a sentence: in the line's size, and no taller than one of its lines.
  const fit = await page.getByRole("button", { name: "Stäng av tangenterna" }).evaluate((button, line) => {
    const own = getComputedStyle(button);
    const its = getComputedStyle(line!);
    const height = button.getBoundingClientRect().height + parseFloat(own.marginBlockStart) + parseFloat(own.marginBlockEnd);
    return { size: [own.fontSize, its.fontSize], noTaller: Math.round(height) <= Math.round(parseFloat(its.lineHeight)) };
  }, await keys.elementHandle());
  expect(fit.size[0], "one size on the line").toBe(fit.size[1]);
  expect(fit.noTaller, "the line keeps its height").toBe(true);
});

/** Safari's writer, independently of lib/webm-keyframes: every SimpleBlock's keyframe flag off, in place. */
function asSafariWrites(bytes: Uint8Array) {
  const vint = (at: number) => {
    const length = Math.clz32(bytes[at]) - 23;
    let value = bytes[at] & (0xff >> length);
    for (let i = 1; i < length; i++) value = value * 256 + bytes[at + i];
    return { length, value, unknown: value === 2 ** (7 * length) - 1 };
  };
  const skip = (at: number) => at + (Math.clz32(bytes[at]) - 23);
  let at = skip(0);
  at += vint(at).length + vint(at).value; // the EBML header
  at = skip(at);
  at += vint(at).length; // into the Segment
  while (at < bytes.length) {
    const id = [...bytes.subarray(at, skip(at))].reduce((n, b) => n * 256 + b, 0);
    const size = vint(skip(at));
    const data = skip(at) + size.length;
    if (id === 0x1f43b675) {
      at = data; // into the Cluster
      continue;
    }
    if (id === 0xa3) bytes[data + vint(data).length + 2] &= 0x7f;
    at = data + size.value;
  }
  return bytes;
}

test("a recording Safari wrote plays and seeks in Chromium once every block is a keyframe", async ({ page }, info) => {
  test.skip(info.project.name !== "laptop-1440-light", "one Chromium is enough: the defect is its demuxer's");
  await page.goto("/");
  // The fake microphone's tone, recorded as the app records, in chunks.
  const recorded = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
    recorder.start(500);
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    await new Promise((resolve) => ((recorder.onstop = resolve), recorder.stop()));
    stream.getTracks().forEach((track) => track.stop());
    return Promise.all(chunks.map(async (chunk) => [...new Uint8Array(await chunk.arrayBuffer())]));
  });
  const safari = asSafariWrites(new Uint8Array(recorded.flat()));
  const { withKeyframes } = await import("../../lib/webm-keyframes");
  const chunks = recorded.map((chunk, i) => safari.slice(recorded.slice(0, i).flat().length, recorded.slice(0, i + 1).flat().length));
  const marked = await withKeyframes(chunks, "audio/webm;codecs=opus");
  const files = { safari: [...safari], marked: [...new Uint8Array(await new Blob(marked as BlobPart[]).arrayBuffer())] };

  const played = await page.evaluate(async (files) => {
    const results: Record<string, { seek: string; time: number; error: string | null }> = {};
    for (const [name, bytes] of Object.entries(files)) {
      const audio = new Audio(URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "audio/webm" })));
      audio.muted = true;
      const next = (...events: string[]) =>
        new Promise<string>((resolve) => {
          const timer = setTimeout(() => resolve("timeout"), 5_000);
          for (const event of events) audio.addEventListener(event, () => (clearTimeout(timer), resolve(event)), { once: true });
        });
      await next("loadedmetadata", "error");
      audio.currentTime = 1.5;
      const seek = await next("seeked", "error");
      // Not awaited: a play() on audio that failed to seek never settles.
      void audio.play().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 600));
      results[name] = { seek, time: audio.currentTime, error: audio.error?.message ?? null };
      audio.pause();
    }
    return results;
  }, files);
  info.annotations.push({ type: "playback", description: JSON.stringify(played) });
  expect(played.safari.seek, "Safari's file as written cannot seek here; if it can, Chromium has changed and the marking may go").toBe("error");
  expect(played.marked).toMatchObject({ seek: "seeked", error: null });
  expect(played.marked.time, "and it plays on from where it was sought").toBeGreaterThan(1.7);
});

test("scrolling a paused transcript adds nothing to the player, and scrolling it while it plays offers Följ uppspelningen", async ({ page }, info) => {
  test.skip(!["phone-390-light", "laptop-1440-light"].includes(info.project.name), "a phone and a laptop");
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const dock = page.locator("[data-docked-player]");
  const height = (await dock.boundingBox())!.height;
  await page.locator("[data-turn-index]").first().dispatchEvent("wheel");
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByRole("button", { name: "Följ uppspelningen" }), "nothing plays to follow").toHaveCount(0);
  expect((await dock.boundingBox())!.height, "the player keeps its height").toBe(height);
  await scrollWhilePlaying(page);
});

test("Följ uppspelningen pressed from the keyboard leaves the focus in the player, on its position", async ({ page }, info) => {
  test.skip(!["phone-390-light", "laptop-1440-light"].includes(info.project.name), "a phone and a laptop");
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const follow = await scrollWhilePlaying(page);
  await follow.focus();
  await page.keyboard.press("Enter");
  await expect(follow).toHaveCount(0);
  await expect(page.getByRole("slider", { name: "Position i inspelningen" }), "not the page's body").toBeFocused();
});
