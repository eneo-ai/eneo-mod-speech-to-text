import { expect, test as base } from "@playwright/test";

/**
 * A session of the test's own, made the way a person makes one: the real handshake against the real backend, through the
 * fake Eneo's /module-login (tests/e2e/stub-server.py). The cookies stay in the test's browser context, so the context's
 * pages and its `request` share them, and no other test has them. A test that logs out, or that ends the session, ends
 * only this one on the server, and the teardown's logout then finds nothing to end.
 *
 * Ask for `session` to be signed in. A test for the signed-out page leaves it out and starts with no cookie. `login` is
 * the login at the fake Eneo and `eneo` its origin, for a test that ends the login there as a changed password does.
 */
export const test = base.extend<{ session: { user: string; login: string; eneo: string } }>({
  session: async ({ context, baseURL }, use) => {
    // The backend sends the browser to Eneo with the login's state, which the stub knows the login by (its
    // /__stub/end-session ends this one alone); from there every redirect is followed: the stub, the backend's callback,
    // and the page it sends on to.
    const start = await context.request.get("/api/auth/login?next=%2Fflows", { maxRedirects: 0 });
    expect(start.status()).toBe(303);
    const eneo = new URL(start.headers()["location"]);
    const login = await context.request.get(eneo.href);
    expect(new URL(login.url()).pathname, "the handshake ends on the page the person asked for").toBe("/flows");
    expect(login.status()).toBe(200);
    const status = await (await context.request.get("/api/auth/status")).json();
    expect(status.authenticated, JSON.stringify(status)).toBe(true);

    await use({ user: status.user.id, login: eneo.searchParams.get("state")!, eneo: eneo.origin });

    // The logout reuses a connection that has been idle since the login, and the server's keep-alive can close it just as
    // the request goes out ("socket hang up"). A logout is safe to send again, once; any other failure stands.
    const logout = () => context.request.post("/api/auth/logout", { headers: { Origin: new URL(baseURL!).origin } });
    await logout().catch((error: Error) => (/socket hang up|ECONNRESET/.test(error.message) ? logout() : Promise.reject(error)));
  },
});
