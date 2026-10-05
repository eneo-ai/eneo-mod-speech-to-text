import type { ComponentType } from "react";
import { LoadFailure } from "@/components/LoadFailure";
import { lazyLoader, useLoaded } from "@/lib/lazy-component";
import styles from "./Markdown.module.css";

type MarkdownNode = { type: string; depth?: number; children?: MarkdownNode[] };

/**
 * A remark step that puts a result's headings under the page's h1: its top heading is an h2 whatever its Markdown
 * level, and deeper ones keep their distance to it, down to h6. It reads the parsed document, so an underlined
 * title counts and nothing in a code block does.
 */
export function remarkResultHeadings() {
  return (tree: MarkdownNode) => {
    const headings: MarkdownNode[] = [];
    const walk = (node: MarkdownNode) => {
      if (node.type === "heading") headings.push(node);
      node.children?.forEach(walk);
    };
    walk(tree);
    const top = Math.min(...headings.map((heading) => heading.depth ?? 1));
    for (const heading of headings) heading.depth = Math.min(6, Math.max(2, (heading.depth ?? 1) - top + 2));
  };
}

type Formatted = ComponentType<{ children: string }>;

// react-markdown, remark-gfm and what they bring are some 60 KB of JavaScript that a page shows no use of until it
// has a text: they load when the first text is shown, and are kept for the next.
const formatter = lazyLoader<Formatted>(() => import("./MarkdownFormatted").then((module) => module.default));

/**
 * Markdown as a page, its headings under the page's h1 (remarkResultHeadings) and bare addresses as links.
 *
 * Until the code that formats it has arrived the text is there, as it was written: nothing is missing and nothing is
 * announced twice, and the server and the first render of the browser agree, since neither has the code yet. If it
 * cannot be fetched (a page older than the deploy that replaced its files, a connection that dropped) the text stays
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
