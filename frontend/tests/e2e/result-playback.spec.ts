import { expect, test } from "./gate";
import { isLaptop, result, STATES } from "./screens";
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

test("a word in the result seeks its audio and the highlight follows playback", async ({ page }, info) => {
  test.skip(!["phone-390-light", "laptop-1440-light", "laptop-1440-dark", "forced-colors"].includes(info.project.name));
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const word = page.locator("[data-word-start]").filter({ hasText: /^punkten$/ }).first();
  const start = Number(await word.getAttribute("data-word-start"));
  await word.click();
  await expect.poll(() => page.locator("audio").first().evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeCloseTo(start, 1);
  await expect(word).toHaveAttribute("aria-current", "true");
  await expect(page.locator('[data-word-start][aria-current="true"]')).toHaveCount(1);

  await page.getByRole("button", { name: "Spela upp", exact: true }).click();
  await expect.poll(() => page.locator("audio").first().evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(start + 0.7);
  await expect(word).not.toHaveAttribute("aria-current", "true");
  await expect(page.locator('[data-word-start][aria-current="true"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Pausa uppspelningen" }).click();
});

test("a search hit in the result remains distinct from the word at the playhead", async ({ page }, info) => {
  test.skip(!["phone-390-light", "laptop-1440-light", "laptop-1440-dark", "forced-colors"].includes(info.project.name));
  await result(page);
  if (!isLaptop(info)) await page.getByRole("tab", { name: "Transkribering" }).click();
  const word = page.locator("[data-word-start]").filter({ hasText: /^punkten$/ }).first();
  await word.click();
  await expect(word).toHaveAttribute("aria-current", "true");
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
  const word = page.locator("[data-word-start]").filter({ hasText: /^punkten$/ }).first();
  await word.click();
  await expect(word).toHaveAttribute("aria-current", "true");
  await page.getByRole("textbox", { name: "Sök i transkriberingen" }).fill("höjs");
  for (const [name, target] of [["active word", word], ["search hit", page.locator('[data-hit="current"]')]] as const) {
    const pair = await textContrast(target);
    info.annotations.push({ type: "contrast", description: `${name}: ${JSON.stringify(pair)}` });
    expect(pair.ratio, `${name}: ${JSON.stringify(pair)} (WCAG 1.4.3)`).toBeGreaterThanOrEqual(4.5);
  }
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
