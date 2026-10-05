import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkResultHeadings } from "./Markdown";
import styles from "./Markdown.module.css";

const COMPONENTS: Components = {
  // react-markdown blanks an address it will not follow (javascript:, data:), and a link with an empty href reloads the
  // page, work in progress with it: such a link, and such an image (an empty src asks for the page itself), are their words.
  a: ({ node: _node, href, children, ...props }) => (href ? <a href={href} {...props}>{children}</a> : <>{children}</>),
  img: ({ node: _node, src, alt, ...props }) => (src ? <img src={src} alt={alt} {...props} /> : <>{alt}</>),
};

// The footnotes' words default to English. Their heading is hidden by the module's own rule, which a screen reader still reads.
const REHYPE = {
  footnoteLabel: "Fotnoter",
  footnoteLabelProperties: { className: [styles.visuallyHidden] },
  footnoteBackLabel: (reference: number, rereference: number) =>
    `Tillbaka till referens ${reference + 1}${rereference > 1 ? `-${rereference}` : ""}`,
};

/** What Markdown loads on demand: the formatting itself (see Markdown). */
export default function MarkdownFormatted({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkResultHeadings]} remarkRehypeOptions={REHYPE} components={COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
}
