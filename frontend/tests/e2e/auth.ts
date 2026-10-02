import { expect, test as base } from "@playwright/test";

/**
 * A session of the test's own, made the way a person makes one: the real handshake against the real backend, through the
 * fake Eneo's /module-login (tests/e2e/stub-server.py). The cookies stay in the test's browser context, so the context's
 * pages and its `request` share them, and no other test has them. A test that logs out, or that ends the session, ends
 * only this one on the server, and the teardown's logout then finds nothing to end.
 *
 * Ask for `session` to be signed in. A test for the signed-out page leaves it out and starts with no cookie.
 */
export const test = base.extend<{ session: { user: string } }>({
  session: async ({ context, baseURL }, use) => {
    // The request follows every redirect: the backend, the stub, the backend's callback, and the page it sends on to.
    const login = await context.request.get("/api/auth/login?next=%2Fflows");
    expect(new URL(login.url()).pathname, "the handshake ends on the page the person asked for").toBe("/flows");
    expect(login.status()).toBe(200);
    const status = await (await context.request.get("/api/auth/status")).json();
    expect(status.authenticated, JSON.stringify(status)).toBe(true);

    await use({ user: status.user.id });

    await context.request.post("/api/auth/logout", { headers: { Origin: new URL(baseURL!).origin } });
  },
});
