// What a browser fetches on one cold visit of a page of the module, signed in: the list that live_load.py replays at an arrival rate
// (B4.2 check 15), and what the stress test's list of files is held against.
//
// usage: PW_DIR=<frontend dir with node_modules> node visit_resources.cjs <base url> <path>
//   <base url>  the module as a browser reaches it (its Eneo must be reachable from here: the sign-in handshake goes there)
//   <path>      the page, for example /flows/<flow id>
// A fresh context, so an empty cache, signs in through the SSO handshake (run by the context's own request client, as auth-preload.cjs does)
// and loads <path> to network idle. Prints one JSON object: {"requests": [{"path", "method", "type"}]} for every request to the module's own
// origin, in the order the browser made them: scripts and lazy route chunks, styles, fonts, images and the API calls the page makes.
const [, , base, path] = process.argv;
const { chromium } = require(process.env.PW_DIR + "/node_modules/@playwright/test");
(async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "sv-SE" });
    await context.request.get(`${base}/api/auth/login?next=/flows`);
    if (!(await context.cookies(base)).some((cookie) => cookie.name === "eneo_module_session")) {
      throw new Error(`visit_resources: the sign-in handshake at ${base} did not give the context a session`);
    }
    const page = await context.newPage();
    const origin = new URL(base).origin;
    const requests = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin === origin) requests.push({ path: url.pathname + url.search, method: request.method(), type: request.resourceType() });
    });
    await page.goto(base + path, { waitUntil: "networkidle" });
    console.log(JSON.stringify({ requests }));
  } finally {
    await browser.close();
  }
})();
