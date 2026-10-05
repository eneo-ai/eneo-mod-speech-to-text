import { expect, test } from "./gate";
import { fileBackedText, isLaptop } from "./screens";
import ids from "../fixtures/ids.json";

test("copying or sharing a file-backed preview says that it is only the beginning", async ({ page }, info) => {
  test.skip(!["phone-320-light", "phone-320-dark", "laptop-1440-light", "laptop-1440-dark"].includes(info.project.name), "narrow and wide action bars, in both themes");
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { document.body.dataset.copiedText = text; } } });
    Object.defineProperty(navigator, "share", { value: async (data: ShareData) => { document.body.dataset.sharedText = data.text; } });
    Object.defineProperty(navigator, "canShare", { value: () => false });
  });
  const answer = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/runs/${ids.runs.fileText}/`) && response.request().method() === "GET");
  await fileBackedText(page);
  const preview: string = (await (await answer).json()).result.preview;
  if (isLaptop(info)) {
    await page.getByRole("button", { name: "Kopiera början", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Fler alternativ" }).click();
    await page.getByRole("menuitem", { name: "Kopiera början", exact: true }).click();
    await page.getByRole("button", { name: "Fler alternativ" }).click();
    await page.getByRole("menuitem", { name: "Dela början", exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute("data-shared-text", preview);
  }
  await expect(page.locator("body")).toHaveAttribute("data-copied-text", preview);
  await expect(page.getByRole("link", { name: "Ladda ner textfilen, Resultat.txt", exact: true })).toBeVisible();
});
