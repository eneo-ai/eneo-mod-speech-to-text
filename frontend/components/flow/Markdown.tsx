import type { ComponentType } from "react";
import { LoadFailure } from "@/components/LoadFailure";
import { lazyLoader, useLoaded } from "@/lib/lazy-component";
import styles from "./Markdown.module.css";

type Formatted = ComponentType<{ children: string }>;

// The design system's Markdown (its parser and renderer) is some 110 KB of JavaScript (35 KB compressed) that a page shows no use of
// until it has a text: it loads when the first text is shown, and is kept for the next.
const formatter = lazyLoader<Formatted>(() => import("./MarkdownFormatted").then((module) => module.default));

/**
 * Markdown as a page, its headings under the page's h1 (its top heading is an h2) and bare addresses as links.
 *
 * Until the code that formats it has arrived the text is there, as it was written: nothing is missing and nothing is
 * announced twice. If it cannot be fetched (a page older than the deploy that replaced its files, a connection that dropped) the text stays
 * and a line offers the person's reload; nothing reloads by itself, since the page may hold work not yet saved.
 */
export function Markdown({ children }: { children: string }) {
  const { value: Formatted, failed } = useLoaded(formatter);
  if (Formatted) return <Formatted>{children}</Formatted>;
  return (
    <>
      <p className={styles.plain}>{children}</p>
      {failed && <LoadFailure>Texten visas utan formatering, den kunde inte läsas in.</LoadFailure>}
    </>
  );
}
