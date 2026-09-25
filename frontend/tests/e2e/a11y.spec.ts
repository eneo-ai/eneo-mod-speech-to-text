/**
 * Every state at every width and theme: axe (no WCAG violation at any impact,
 * no serious or critical best practice; what axe cannot decide is listed as a
 * manual check), every control named in Chromium's own tree, placeholder text at 4.5:1, target sizes
 * (24 px, WCAG 2.5.8; 44 px under pointer: coarse), reflow at 320 px and 200 % zoom (WCAG
 * 1.4.10, and 1.4.12 text spacing), and no endless motion with reduced
 * motion. The measurements go to findings.json in each test's output folder.
 */
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { axe, blocking, endlessAnimations, placeholderContrast, reflow, targetSizes, unnamedControls } from "./checks";
import { STATES } from "./screens";

// WCAG 1.4.12: the spacing a user may set must not cut anything off.
const TEXT_SPACING =
  "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }";

for (const state of STATES) {
  test(state.name, async ({ page }, info) => {
    test.skip(state.only ? !state.only(info) : false, "not on this width");
    const project = info.project.name;
    // Content fits the narrowest widths and the widest screens alike.
    const edges = project.startsWith("phone-320") || project === "zoom-200" || project.startsWith("ultrawide");
    await state.go(page, info);

    const scan = await axe(page);
    const unnamed = await unnamedControls(page);
    const placeholders = await placeholderContrast(page);
    const targets = await targetSizes(page, 24, true);
    // A mouse gets the WCAG minimum; a finger gets the house bar of 44 px.
    const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    const touchTargets = coarse ? await targetSizes(page, 44, false) : [];
    const layout = edges ? await reflow(page) : null;
    let spaced = null;
    if (project === "phone-390-light" || project.startsWith("ultrawide")) {
      const style = await page.addStyleTag({ content: TEXT_SPACING });
      spaced = await reflow(page);
      await style.evaluate((element) => (element as Element).remove());
    }
    const motion = info.project.use.reducedMotion === "reduce" ? await endlessAnimations(page) : [];

    const findings = { state: state.name, project, axe: scan, unnamed, placeholders, targets, touchTargets, reflow: layout, textSpacing: spaced, motion };
    writeFileSync(info.outputPath("findings.json"), JSON.stringify(findings, null, 2));

    const list = (items: string[]) => items.map((item) => `\n  - ${item}`).join("");
    // What axe could not decide is a check for a person, listed in the report rather than dropped.
    for (const item of scan.incomplete) {
      info.annotations.push({ type: "manual check", description: `${item.id}: ${item.help} (${item.nodes} element(s))` });
    }
    expect.soft(
      blocking(scan.violations).map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.map((n) => n.target).join(", ")}`),
      "axe: WCAG violations, and serious or critical best practice",
    ).toEqual([]);
    expect.soft(unnamed, "controls without a name in Chromium's accessibility tree (WCAG 4.1.2)").toEqual([]);
    expect.soft(placeholders, "placeholder text under 4.5:1, which axe does not measure (WCAG 1.4.3)").toEqual([]);
    expect.soft(targets, `targets under 24 px (WCAG 2.5.8):${list(targets)}`).toEqual([]);
    expect.soft(touchTargets, `targets under 44 px on a coarse pointer (house bar):${list(touchTargets)}`).toEqual([]);
    if (layout) {
      expect.soft(layout.horizontalScroll, "horizontal scroll (WCAG 1.4.10)").toBe(false);
      expect.soft([...layout.beyond, ...layout.clipped], "content past the edge or cut off (WCAG 1.4.10)").toEqual([]);
    }
    if (spaced) expect.soft(spaced.clipped, "content cut off with increased text spacing (WCAG 1.4.12)").toEqual([]);
    expect.soft(motion, "endless animation despite reduced motion").toEqual([]);
  });
}
