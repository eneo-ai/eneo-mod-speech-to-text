// Makes page-cost.cjs measure the pages behind the sign-in: the flow list and a flow, not the sign-in screen it would see without a
// session. page-cost.cjs has no option for a session, so this file is preloaded (node -r) and wraps chromium.launch: every context the
// script opens first signs in through the module's SSO handshake (GET /api/auth/login -> the Eneo's /module-login -> /api/auth/callback,
// run by the context's own request client, which shares the context's cookies). Each context has its own session; the page-cost.cjs
// measurements are not touched (no extra page, no throttling before the sign-in), and a context that did not get the session cookie fails
// the run instead of measuring the sign-in screen.
//
// usage, from the repository root:
//   PW_DIR=<frontend dir with node_modules> BASE_URL=<base url> node -r ./deploy/acceptance/auth-preload.cjs deploy/acceptance/page-cost.cjs \
//     <frontend dir> <base url> <label> /flows /flows/flow-1
//   <base url> is the image as a browser reaches it (its MODULE_PUBLIC_URL); its Eneo must be reachable from this machine as well.
//   PW_DIR and the frontend dir given to page-cost.cjs are the same directory: any one whose node_modules hold @playwright/test.
// Without the preload page-cost.cjs measures the sign-in screen for every path (B0.1 measured both; the bead has the numbers).
const { chromium } = require(process.env.PW_DIR + "/node_modules/@playwright/test");
const base = process.env.BASE_URL.replace(/\/$/, "");
const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const browser = await launch(...args);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options = {}) => {
    const context = await newContext(options);
    await context.request.get(`${base}/api/auth/login?next=/flows`);
    if (!(await context.cookies(base)).some((cookie) => cookie.name === "eneo_module_session")) {
      throw new Error(`auth-preload: the sign-in handshake at ${base} did not give the context a session`);
    }
    return context;
  };
  return browser;
};
