/**
 * While the login has ended, nothing of the page is shown or within reach: not the page, and not a dialog the page
 * had open. Proved in the browser as a person meets it (what is visible, what takes focus, what the accessibility
 * tree holds), because a modal dialog leaves an inert ancestor's inertness and an attribute cannot show that.
 */
import { expect, test } from "@playwright/test";
import { endLogin, isLaptop, result, run, sessionWarning } from "./screens";

test.beforeEach(({}, info) => test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "two widths are enough"));

const signIn = { name: "Du behöver logga in igen" };

test("a page dialog open when the login ends is covered with the page, and is back with its edit after the new login", async ({ page }) => {
  await run(page, "run-review", "flow-2");
  await expect(page.getByRole("button", { name: /^Spela från/ }).first()).toBeVisible();
  await page.getByRole("button", { name: "Namnge talarna" }).click();
  const naming = page.getByRole("dialog", { name: "Namnge talarna" });
  const name = naming.getByLabel(/^Vem är Talare 1/);
  await name.fill("Zara Testsson");

  await endLogin(page);
  await expect(naming, "the page's dialog is not shown, nor in the accessibility tree").toBeHidden();
  // What a screen reader is given holds the sign-in dialog and nothing of the page.
  const tree = await page.locator("body").ariaSnapshot();
  expect(tree).toContain("Du behöver logga in igen");
  expect(tree).not.toMatch(/Namnge talarna|Vem är vem|Zara Testsson/);
  // Focus stays in the sign-in dialog however far Tab goes.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest('[role="alertdialog"]') !== null), `Tab ${i + 1}`).toBe(true);
  }

  // The same person signs in again (here: the session answers again, and the page asks when it becomes visible).
  await page.unroute("**/api/auth/status");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alertdialog", signIn)).toBeHidden();
  await expect(naming).toBeVisible();
  await expect(name).toHaveValue("Zara Testsson");
});

test("the warning already open when the login ends becomes the sign-in dialog, which nothing but a new login closes", async ({ page }) => {
  await sessionWarning(page);
  await endLogin(page);
  const dialog = page.getByRole("alertdialog", signIn);
  await expect(dialog.getByRole("button", { name: "Stäng" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("link", { name: /Nämndmöte till rapport/ })).toBeHidden();
});

// The PDF preview is a page dialog like the naming dialog, with a viewer in it that must not be reloaded by the cover.
test("the PDF preview open when the login ends is covered with the page, and is back with its viewer after the new login", async ({ page }, info) => {
  test.skip(!isLaptop(info), "below a laptop's width the PDF opens in a tab of its own");
  await result(page);
  await page.getByRole("button", { name: /^Öppna Protokoll .*\.pdf$/ }).click();
  const preview = page.getByRole("dialog", { name: /^Protokoll .*\.pdf$/ });
  await expect(preview.locator("iframe")).toBeVisible();

  await endLogin(page);
  await expect(preview, "the preview is not shown, nor in the accessibility tree").toBeHidden();
  const tree = await page.locator("body").ariaSnapshot();
  expect(tree).toContain("Du behöver logga in igen");
  expect(tree).not.toMatch(/Protokoll kommunstyrelsen|Öppna i ny flik|Ladda ner/);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest('[role="alertdialog"]') !== null), `Tab ${i + 1}`).toBe(true);
  }

  await page.unroute("**/api/auth/status");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alertdialog", signIn)).toBeHidden();
  await expect(preview).toBeVisible();
  await expect(preview.locator("iframe")).toHaveAttribute("src", /disposition=inline/);
});
