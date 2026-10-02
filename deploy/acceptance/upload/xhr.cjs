// Sends one upload as the app does: XMLHttpRequest + FormData("upload_file") from a Blob, in Chromium, signed in through the SSO handshake.
// usage: PW_DIR=<frontend dir with node_modules> node xhr.cjs <base url> <bytes> <tag> [path]
// The page names its user (X-Expected-User, EXPECTED_USER, default user-1) as the app does on a write.
const [, , base, bytesArg, tag, pathArg] = process.argv;
const { chromium } = require(process.env.PW_DIR + "/node_modules/@playwright/test");
const path = pathArg || "/api/eneo/flows/flow-1/steps/step-1/runtime-files/";
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${base}/api/auth/login?next=/`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(`${base}/**`);
  const result = await page.evaluate(
    ({ bytes, tag, path, user }) =>
      new Promise((resolve) => {
        const blob = new Blob([new Uint8Array(bytes)], { type: "audio/webm" });
        const fd = new FormData();
        fd.append("upload_file", blob, "opptagning.webm");
        const xhr = new XMLHttpRequest();
        const t0 = performance.now();
        xhr.open("POST", `${path}?case=${tag}`);
        xhr.setRequestHeader("X-Expected-User", user);
        xhr.onload = () => resolve({ status: xhr.status, seconds: +((performance.now() - t0) / 1000).toFixed(1), body: xhr.responseText.slice(0, 80) });
        xhr.onerror = () => resolve({ error: "xhr error", seconds: +((performance.now() - t0) / 1000).toFixed(1) });
        xhr.send(fd);
      }),
    { bytes: Number(bytesArg), tag, path, user: process.env.EXPECTED_USER || "user-1" },
  );
  console.log(JSON.stringify(result));
  await browser.close();
})();
