import { Markdown, visitMarkdownNodes, type MarkdownAstBlockContent, type MarkdownAstExtensionNode } from "@astryxdesign/core/Markdown";
import { createMarkdownPlugin } from "@astryxdesign/core/Markdown/plugins";

const DEPTHS = [1, 2, 3, 4, 5, 6] as const;

/**
 * The tree with every heading `by` levels higher. A heading with another depth is made anew, with no source position:
 * the design system takes a depth that differs from the source's only on a heading that does not claim to be it.
 */
function lifted(node: MarkdownAstBlockContent<MarkdownAstExtensionNode>, by: number): MarkdownAstBlockContent<MarkdownAstExtensionNode> {
  switch (node.type) {
    case "heading":
      return { type: "heading", depth: DEPTHS[node.depth - by - 1] ?? 1, children: node.children, data: node.data };
    case "blockquote":
      return { ...node, children: node.children.map((child) => lifted(child, by)) };
    case "list":
      return { ...node, children: node.children.map((item) => ({ ...item, children: item.children.map((child) => lifted(child, by)) })) };
    default:
      return node;
  }
}

/**
 * A result's headings relative to its top one: whatever its level, the top heading is the document's `#`, and the
 * deeper ones keep their distance to it. `headingLevelStart` then puts that `#` under the page's h1. It reads the
 * parsed headings; code blocks keep their contents unchanged.
 */
const topHeadingFirst = createMarkdownPlugin({
  name: "top-heading-first",
  apiVersion: 1,
  transform: (document) => {
    let top = 7;
    visitMarkdownNodes(document, "heading", (heading) => void (top = Math.min(top, heading.depth)));
    return top > 1 && top < 7 ? { ...document, children: document.children.map((child) => lifted(child, top - 1)) } : document;
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
