// What a page costs the server in memory after a visitor has used it: the "loaded" row of baseline.json (resident memory after /flows
// was loaded 20 times), which check 14 holds the image against.
//
// usage: node loads.cjs <frontend dir with node_modules> <base url> <path> <count>
//   <frontend dir>  any directory whose node_modules hold @playwright/test (1.63.0, its Chromium installed)
//   <base url>      the module as a browser reaches it (its MODULE_PUBLIC_URL; its Eneo must be reachable from here: the sign-in handshake goes there)
//   <path> <count>  the page and how many times it is loaded (the baseline: /flows, 20)
// One Chromium with one signed-in context loads <path> <count> times, each to network idle. Prints one JSON line: how many loads were
// answered 200, where the last one ended (a sign-in screen would show here), and the seconds it took. Read the server's memory
// afterwards, from inside the container (upload/container_probe.py snapshot).
const [, , pwDir, base, path, count] = process.argv;
const { chromium } = require(pwDir + "/node_modules/@playwright/test");
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "sv-SE" });
  const page = await context.newPage();
  await page.goto(base + "/api/auth/login?next=" + encodeURIComponent(path), { waitUntil: "networkidle" });
  let ok = 0;
  const t0 = Date.now();
  for (let i = 0; i < Number(count); i++) {
    const r = await page.goto(base + path, { waitUntil: "networkidle" });
    if (r && r.status() === 200) ok++;
  }
  console.log(JSON.stringify({ path, loads: Number(count), ok, finalUrl: page.url(), seconds: +((Date.now() - t0) / 1000).toFixed(1) }));
  await browser.close();
})();
