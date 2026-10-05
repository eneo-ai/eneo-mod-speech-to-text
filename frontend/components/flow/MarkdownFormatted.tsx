import { Markdown, visitMarkdownNodes } from "@astryxdesign/core/Markdown";
import { createMarkdownPlugin } from "@astryxdesign/core/Markdown/plugins";

type Node = { readonly type: string; readonly depth?: number; readonly children?: readonly Node[] };

/**
 * The tree with every heading `by` levels higher. A heading with another depth is made anew, with no source position:
 * the design system takes a depth that differs from the source's only on a heading that does not claim to be it.
 */
const lifted = (node: Node, by: number): Node =>
  node.type === "heading"
    ? { type: "heading", depth: node.depth! - by, children: node.children }
    : node.children
      ? { ...node, children: node.children.map((child) => lifted(child, by)) }
      : node;

/**
 * A result's headings relative to its top one: whatever its level, the top heading is the document's `#`, and the
 * deeper ones keep their distance to it. `headingLevelStart` then puts that `#` under the page's h1. It reads the
 * parsed document, so an underlined title counts and nothing in a code block does.
 */
const topHeadingFirst = createMarkdownPlugin({
  name: "top-heading-first",
  apiVersion: 1,
  transform: (document) => {
    let top = 7;
    visitMarkdownNodes(document, "heading", (heading) => void (top = Math.min(top, heading.depth)));
    return top > 1 && top < 7 ? (lifted(document, top - 1) as unknown as typeof document) : document;
  },
});
const PLUGINS = [topHeadingFirst];

/** What Markdown loads on demand: the formatting itself (see Markdown). */
export default function MarkdownFormatted({ children }: { children: string }) {
  return (
    <Markdown headingLevelStart={2} autolink="gfm" plugins={PLUGINS}>
      {children}
    </Markdown>
  );
}
