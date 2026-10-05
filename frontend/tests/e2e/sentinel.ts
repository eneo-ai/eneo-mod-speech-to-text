import { expect, type BrowserContext, type Page } from "@playwright/test";

/** Whether the gate runs on its real target: the built UI served by the real backend under the strict policy. */
export const REAL = process.env.GATE_TARGET === "real";

/** The sentinel of each browser context, so a state can declare what it is meant to cause without being handed one. */
const watching = new WeakMap<BrowserContext, Sentinel>();

/** Declares, for the test whose page this is, the failures a state is meant to cause. Nothing on the dev profile. */
export function declare(page: Page, expectations: Expectation[] | undefined) {
  watching.get(page.context())?.expect(...(expectations ?? []));
}

/**
 * What the gate's real target watches for in every test, under the strict policy (`script-src 'self'; style-src 'self'`
 * and the rest of backend/app/security_headers.json): nothing is filtered silently.
 *
 * - A Content-Security-Policy violation fails the test, always. A state cannot declare one: the policy is never
 *   relaxed to make a test pass.
 * - A redirect fails the test (a 301, 302, 303, 307 or 308 on a fetch, a stream, a frame, an image or a page). It is the
 *   evidence that the browser's exact paths, with and without the trailing slash, never meet one behind a proxy that
 *   answers `http://`. The only ones allowed are the sign-in handshake's: the backend's /api/auth/login and
 *   /api/auth/callback, and the fake Eneo's /module-login.
 * - A console error, an uncaught error or a failed request fails the test unless the state declared it, and a declared
 *   failure that did not occur fails it as well: a state that is meant to cause an error proves that it does. The one rule
 *   that is not a declaration: a request that the browser or the page cancelled (net::ERR_ABORTED) is no failed request.
 */
export interface Expectation {
  /** The text of a console error or an uncaught error and, in brackets, where it came from: `/status of 503.*api\/eneo\/flows/`. */
  console?: RegExp;
  /** A failed request as `METHOD url: reason`, e.g. an abort: `/POST .*\/api\/auth\/logout: net::ERR_FAILED/`. */
  requestFailed?: RegExp;
  /** The failure may happen and need not: what the page does as a matter of course, which no test is there to prove. */
  optional?: true;
}

/** The redirects of the sign-in handshake. */
const HANDSHAKE = new Set(["/api/auth/login", "/api/auth/callback", "/module-login"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The page's listener for `securitypolicyviolation`, which reports at once, so a navigation does not lose what it saw. */
const LISTEN = () => {
  document.addEventListener(
    "securitypolicyviolation",
    (event) =>
      void (window as unknown as { __sentinelViolation(report: string): void }).__sentinelViolation(
        `${event.violatedDirective} blocked ${event.blockedURI || "inline"} (${event.sourceFile || "the page"}:${event.lineNumber}) ${event.disposition}`,
      ),
    true,
  );
};

export class Sentinel {
  readonly violations: string[] = [];
  readonly redirects: string[] = [];
  private readonly console: string[] = [];
  private readonly failed: string[] = [];
  private readonly declared: { expectation: Expectation; seen: boolean }[] = [];

  /** The failures this test is meant to cause. */
  expect(...expectations: (Expectation | undefined)[]) {
    for (const expectation of expectations) if (expectation) this.declared.push({ expectation, seen: false });
  }

  async watch(context: BrowserContext) {
    watching.set(context, this);
    await context.exposeBinding("__sentinelViolation", (_source, report: string) => void this.violations.push(report));
    await context.addInitScript(LISTEN);
    context.on("console", (message) => {
      // The URL is where the browser says the message came from: for a failed resource, the resource.
      if (message.type() === "error") this.console.push(`${message.text()} [${message.location().url}]`);
    });
    context.on("weberror", (error) => void this.console.push(`uncaught: ${error.error().message}`));
    context.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText ?? "failed";
      // net::ERR_ABORTED is a request that the browser or the page itself cancelled: an audio element that has what it
      // needs of a file read by range, a download that took the place of a navigation, a page that was closed or left
      // with the icon still on its way. The network failing is another text (ERR_FAILED, ERR_CONNECTION_REFUSED, ...).
      if (reason === "net::ERR_ABORTED") return;
      this.failed.push(`${request.method()} ${request.url()}: ${reason}`);
    });
    context.on("response", (response) => {
      if (!REDIRECTS.has(response.status()) || HANDSHAKE.has(new URL(response.url()).pathname)) return;
      this.redirects.push(`${response.status()} ${response.request().method()} ${response.url()} to ${response.headers()["location"] ?? "nowhere"}`);
    });
  }

  /** What was not declared; and what was declared and did not happen. */
  private unexpected(found: string[], pick: (expectation: Expectation) => RegExp | undefined) {
    return found.filter((text) => {
      const match = this.declared.find(({ expectation }) => pick(expectation)?.test(text));
      if (match) match.seen = true;
      return !match;
    });
  }

  verify() {
    const unexpectedConsole = this.unexpected(this.console, (expectation) => expectation.console);
    const unexpectedFailed = this.unexpected(this.failed, (expectation) => expectation.requestFailed);
    // Each declaration is judged on its own: a console pattern that matched a console error is seen.
    const missing = this.declared
      .filter(({ seen, expectation }) => !seen && !expectation.optional)
      .map(({ expectation }) => String(expectation.console ?? expectation.requestFailed));
    return { unexpectedConsole, unexpectedFailed, missing };
  }

  /** Forgets what was seen and declared: for the sentinel's own tests, which cause what it watches for. */
  reset() {
    for (const list of [this.violations, this.redirects, this.console, this.failed, this.declared]) list.length = 0;
  }

  /** The assertions at the end of a test. `expect.soft`: every kind is reported, not only the first. */
  assertClean() {
    const { unexpectedConsole, unexpectedFailed, missing } = this.verify();
    expect.soft(this.violations, "Content-Security-Policy violations: the policy is never relaxed, so the source is fixed").toEqual([]);
    expect.soft(this.redirects, "redirects: the browser's exact paths must not meet one").toEqual([]);
    expect.soft(unexpectedConsole, "console errors that the state did not declare").toEqual([]);
    expect.soft(unexpectedFailed, "failed requests that the state did not declare").toEqual([]);
    expect.soft(missing, "declared failures that did not occur").toEqual([]);
  }
}
