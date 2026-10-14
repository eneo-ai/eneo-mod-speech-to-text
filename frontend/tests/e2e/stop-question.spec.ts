/**
 * Stoppa asks first only where it cannot be taken back: the flow takes no further part of the recording (a flow of one
 * file), so Fortsätt spela in could not follow. Going on is the question's safe answer and has the focus. Everywhere
 * else Stoppa stops at once, and Fortsätt spela in is offered after it.
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./gate";
import { endLogin, limitAudio, record, setup } from "./screens";

test.beforeEach(({}, info) => test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "one laptop and one phone"));

const question = (page: Page) => page.getByRole("alertdialog", { name: "Stoppa inspelningen?" });
const barStop = (page: Page) => page.getByRole("toolbar", { name: "Inspelningen" }).getByRole("button", { name: "Stoppa" });
const ready = (page: Page) => expect(page.getByRole("heading", { name: "Inspelningen är klar" })).toBeVisible();

test("in a flow of one file, Stoppa asks first: going on keeps recording, and Stoppa stops with nothing offering to go on", async ({ page }) => {
  await limitAudio(page, 60 * 60, 1);
  await setup(page);
  await record(page, "Spela in");

  await barStop(page).click();
  await expect(question(page)).toBeVisible();
  await expect(question(page)).toContainText("Den kan inte fortsätta efteråt.");
  const goOn = question(page).getByRole("button", { name: "Fortsätt spela in" });
  await expect(goOn, "going on has the focus").toBeFocused();
  await goOn.click();
  await expect(question(page)).toBeHidden();
  await expect(barStop(page), "the focus is back on Stoppa").toBeFocused();
  await expect(page.getByText("Spelar in", { exact: true }).first(), "still recording").toBeVisible();

  await barStop(page).click();
  await expect(question(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(question(page), "Escape goes on too").toBeHidden();
  await expect(barStop(page)).toBeVisible();

  await barStop(page).click();
  await question(page).getByRole("button", { name: "Stoppa" }).click();
  await ready(page);
  await expect(page.getByRole("button", { name: "Fortsätt spela in" }), "what the question said: it cannot go on").toHaveCount(0);
});

test("where the flow takes another part, Stoppa stops at once and Fortsätt spela in is offered after it", async ({ page }) => {
  await setup(page);
  await record(page, "Spela in");
  await barStop(page).click();
  await ready(page);
  await expect(question(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Fortsätt spela in" })).toBeVisible();
});

test("signed out, Stoppa in the sign-in dialog asks above it, and its answer stops the recording", async ({ page }) => {
  await limitAudio(page, 60 * 60, 1);
  await setup(page);
  await record(page, "Spela in");
  await endLogin(page);
  const signIn = page.getByRole("alertdialog", { name: "Du behöver logga in igen" });
  await page.waitForTimeout(800); // the dialog's own controls ignore a press in their first moment, as the bar's do
  await signIn.getByRole("button", { name: "Stoppa" }).click();
  await expect(question(page)).toBeVisible();
  await expect(question(page).getByRole("button", { name: "Fortsätt spela in" })).toBeFocused();
  await question(page).getByRole("button", { name: "Stoppa" }).click();
  await expect(question(page)).toBeHidden();
  await expect(signIn.getByText("Inspelningen är stoppad och sparad.")).toBeVisible();
});
