"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkResultHeadings } from "./Markdown";

/** What Markdown loads on demand: the formatting itself (see Markdown). */
export default function MarkdownFormatted({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkResultHeadings]}>{children}</ReactMarkdown>;
}
