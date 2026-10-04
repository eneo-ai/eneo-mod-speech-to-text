"use client";

import { useEffect, useState, type ComponentType } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
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
let loaded: Formatted | null = null;
const load = () => import("./MarkdownFormatted").then((module) => (loaded = module.default));

/**
 * Markdown as a page, its headings under the page's h1 (remarkResultHeadings) and bare addresses as links.
 *
 * Until the code that formats it has arrived the text is there, as it was written: nothing is missing and nothing is
 * announced twice, and the server and the first render of the browser agree, since neither has the code yet. If it
 * cannot be fetched (a page older than the deploy that replaced its files, a connection that dropped) the text stays
 * and a press tries again: only that code is fetched again, never the page, which may hold work not yet saved.
 */
export function Markdown({ children }: { children: string }) {
  const [Formatted, setFormatted] = useState<Formatted | null>(() => loaded);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (Formatted) return;
    let current = true;
    setFailed(false);
    load().then(
      (component) => current && setFormatted(() => component),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [Formatted, attempt]);
  if (Formatted) return <Formatted>{children}</Formatted>;
  return (
    <>
      <p className={styles.plain}>{children}</p>
      {(failed || attempt > 0) && (
        <HStack vAlign="center" wrap="wrap" gap={2}>
          <Text as="p" type="supporting" role="status">
            {failed ? "Texten visas utan formatering, den kunde inte läsas in." : "Läser in formateringen…"}
          </Text>
          <Button size="sm" label="Visa formaterat igen" onClick={() => failed && setAttempt(attempt + 1)} />
        </HStack>
      )}
    </>
  );
}
