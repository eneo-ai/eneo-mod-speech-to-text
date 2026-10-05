/** The setup's own wording and fields: what the speaker switch says takes longer, per way of giving the audio. */
import { expect, test } from "./gate";
import { chooseMode, setup } from "./screens";

// Words, not layout: one width is enough.
test.beforeEach(({}, info) => test.skip(info.project.name !== "laptop-1440-light", "words, at one width"));

test("the speaker switch says what takes longer after the way the audio was given", async ({ page }) => {
  await setup(page);
  const choice = page.getByRole("switch", { name: "Märk upp talare" });
  await chooseMode(page, "Spela in");
  await expect(choice).toHaveAccessibleDescription("Tar längre tid efter inspelningen.");
  await chooseMode(page, "Ladda upp");
  await expect(choice).toHaveAccessibleDescription("Tar längre tid efter uppladdningen.");
});
