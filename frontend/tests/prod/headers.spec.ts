import { expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import securityHeaders from "../../../backend/app/security_headers.json";
import { test } from "../e2e/auth";
import ids from "../fixtures/ids.json";

// What the backend says about every answer it gives: the security headers of backend/app/security_headers.json on every
// one, and the rest of what the page's delivery depends on (revalidation, caching, compression, no banner).
const PDF = `/api/eneo/flows/${ids.flows.flow1}/runs/${ids.runs.done}/artifacts/${ids.files.pdf}/content?disposition=inline`;

/** The built files the page names: its entry script and stylesheet, both hashed. */
async function built(request: APIRequestContext): Promise<{ script: string; stylesheet: string }> {
  const page = await (await request.get("/")).text();
  return { script: /\/assets\/index-[\w-]+\.js/.exec(page)![0], stylesheet: /\/assets\/index-[\w-]+\.css/.exec(page)![0] };
}

const header = (response: APIResponse, name: string) => response.headers()[name.toLowerCase()];

test("every answer carries the security headers, and only the inline PDF may be framed, by this origin", async ({ session, context, request }) => {
  const { script } = await built(request);
  const paths = ["/", "/flows", script, "/live-pcm-worklet.js", "/api/nope", "/health"];

  for (const path of paths) {
    const response = await request.get(path);
    for (const [name, value] of Object.entries(securityHeaders)) {
      expect(header(response, name), `${name} of ${path}`).toBe(value);
    }
  }
  const pdf = await context.request.get(PDF);
  expect(pdf.status(), session.user).toBe(200);
  expect(header(pdf, "content-type")).toBe("application/pdf");
  expect(header(pdf, "content-security-policy")).toBe("frame-ancestors 'self'");
  expect(header(pdf, "x-frame-options")).toBe("SAMEORIGIN");
  for (const [name, value] of Object.entries(securityHeaders)) {
    if (name !== "Content-Security-Policy" && name !== "X-Frame-Options") expect(header(pdf, name), `${name} of the PDF`).toBe(value);
  }
});

test("the page revalidates with an ETag, and a file with a hash in its name is immutable", async ({ request }) => {
  const page = await request.get("/");
  const etag = header(page, "etag");

  expect(header(page, "cache-control")).toBe("no-cache");
  expect(etag).toBeTruthy();
  const again = await request.get("/", { headers: { "If-None-Match": etag } });
  expect(again.status()).toBe(304);
  expect(header(again, "etag")).toBe(etag);

  const { script, stylesheet } = await built(request);
  for (const path of [script, stylesheet]) {
    expect(header(await request.get(path), "cache-control"), path).toBe("public, max-age=31536000, immutable");
  }
});

test("the scripts and styles are compressed for a browser that accepts it, and the answers carry no banner", async ({ request }) => {
  const { script, stylesheet } = await built(request);

  for (const path of [script, stylesheet]) {
    const response = await request.get(path, { headers: { "Accept-Encoding": "br, gzip" } });
    expect(header(response, "content-encoding"), path).toMatch(/^(br|gzip)$/);
    expect(header(response, "vary"), path).toContain("Accept-Encoding");
  }
  expect(header(await request.get(script, { headers: { "Accept-Encoding": "identity" } }), "content-encoding")).toBeUndefined();
  for (const path of ["/", script, "/api/nope", "/health"]) {
    const response = await request.get(path);
    expect(header(response, "x-powered-by"), path).toBeUndefined();
    expect(header(response, "server") ?? "", path).not.toMatch(/uvicorn/i);
  }
});
