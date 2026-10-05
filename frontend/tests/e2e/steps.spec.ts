/**
 * The steps of a run at every width: a step's name is its flow author's and as long as they like, so it wraps instead
 * of being cut off with an ellipsis, and the word for its state stays whole beside it, inside the window.
 */
import { expect, test } from "./gate";
import { STATES } from "./screens";

test("a long step name wraps, and its state word stays whole inside the window", async ({ page }, info) => {
  await STATES.find((s) => s.name === "run-progress")!.go(page, info);
  const step = page.getByRole("listitem").filter({ hasText: "Pågår" });
  await step.locator(".astryx-step-label").evaluate((label) => (label.textContent = "Sammanfatta mötet, lista besluten och skriv ett protokoll för nämnden"));
  const measured = await step.evaluate((li) => {
    const label = li.querySelector<HTMLElement>(".astryx-step-label")!;
    const state = [...li.querySelectorAll<HTMLElement>("span")].find((el) => el.textContent === "Pågår")!.getBoundingClientRect();
    return {
      cut: label.scrollWidth > label.clientWidth + 1 || getComputedStyle(label).textOverflow === "ellipsis",
      stateRight: Math.round(state.right),
      stateWidth: Math.round(state.width),
      window: document.documentElement.clientWidth,
    };
  });
  expect(measured.cut, "the name is cut off").toBe(false);
  expect(measured.stateRight, "the state word reaches past the window").toBeLessThanOrEqual(measured.window);
  expect(measured.stateWidth, "the state word is squeezed to a letter a line").toBeGreaterThan(24);
});
