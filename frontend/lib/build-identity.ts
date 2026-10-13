/**
 * The one owner of how the page names the build it runs on, from the backend's answer (`buildIdentity`): as a person
 * reads it under Version and as support gets it from Kopiera supportinformation. The page holds no version of its own:
 * it ships in the backend's image.
 */

import type { BuildIdentity } from "./api";
import { formatDateTime } from "./format";
import { PRODUCT_NAME } from "./product";

/** The repository the image's source label names (Dockerfile, org.opencontainers.image.source); a test holds the two together. */
export const SOURCE_REPOSITORY = "https://github.com/eneo-ai/eneo-mod-speech-to-text";

/**
 * A build as the page shows it: the release, or "Utvecklingsversion" for a build no release names; the commit's first
 * seven characters and its page on GitHub; when it was built. Null where it is not known.
 */
export function buildView(build: BuildIdentity) {
  return {
    release: build.release ?? "Utvecklingsversion",
    commit: build.revision?.slice(0, 7) ?? null,
    commitUrl: build.revision ? `${SOURCE_REPOSITORY}/commit/${build.revision}` : null,
    built: build.build_date ? formatDateTime(build.build_date) : null,
  };
}

/** What Kopiera supportinformation copies: plain lines to paste into a message, each value whole, and where the page runs. */
export function supportText(build: BuildIdentity, origin: string): string {
  return [
    PRODUCT_NAME,
    `Utgåva: ${build.release ?? "utvecklingsversion"}`,
    `Commit: ${build.revision ?? "okänd"}`,
    `Byggd: ${build.build_date ?? "okänd"}`,
    `Adress: ${origin}`,
  ].join("\n");
}
