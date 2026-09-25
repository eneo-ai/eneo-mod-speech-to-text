/**
 * Where the module's backend listens, for Next's /api rewrites and for the
 * server-side reads the pages make (the branding). In `next dev` it runs on
 * the same host; the Compose service name applies in a Compose deployment.
 */
export function backendBase() {
  return (
    process.env.INTERNAL_API_BASE ||
    (process.env.NODE_ENV === "development" ? "http://127.0.0.1:8000" : "http://speech-to-text-backend:8000")
  );
}
