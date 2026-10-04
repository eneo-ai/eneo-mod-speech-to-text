// Serves the production build the way the image ships it (see the Dockerfile): the standalone server, with the
// static files and `public/` beside it, which `next build` leaves out of `.next/standalone`.
// PORT and HOSTNAME come from the environment, as in the image.
import { cpSync } from "node:fs";

const standalone = new URL("../../.next/standalone/", import.meta.url);
cpSync(new URL("../../.next/static", import.meta.url), new URL(".next/static", standalone), { recursive: true });
cpSync(new URL("../../public", import.meta.url), new URL("public", standalone), { recursive: true });
await import(new URL("server.js", standalone).href);
