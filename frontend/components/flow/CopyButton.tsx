import { useEffect, useState } from "react";
import { Button, type ButtonProps } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { useAnnounce } from "@astryxdesign/core/hooks";

type CopyState = "idle" | "copied" | "failed";

/** The attributes a copied text keeps: where a link goes, and how a table's cells and a list's numbers run. */
const KEPT = new Set(["href", "colspan", "rowspan", "start"]);

/**
 * A rendered text as HTML for the clipboard: its structure alone (headings, paragraphs, lists, tables, bold, links),
 * without the page's classes, styles and controls, so a word processor or a mail lays it out in its own style.
 */
export function copyableHtml(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll("button, svg, [aria-hidden='true']").forEach((el) => el.remove());
  // The design system draws a paragraph as a div with the role; on the clipboard it is a paragraph.
  copy.querySelectorAll("[role='paragraph']").forEach((el) => {
    const paragraph = el.ownerDocument.createElement("p");
    paragraph.append(...el.childNodes);
    el.replaceWith(paragraph);
  });
  for (const el of [copy, ...copy.querySelectorAll("*")]) {
    for (const { name } of [...el.attributes]) if (!KEPT.has(name)) el.removeAttribute(name);
  }
  return copy.innerHTML;
}

/**
 * Copies text; the state says "Kopierat" for a moment, or that it failed. With `html`, the text goes formatted too
 * (`copyableHtml`), and a place that takes text alone gets `text`; a browser that cannot write both copies the text.
 */
export function useCopy(text: string, html?: () => string | null): [CopyState, () => Promise<void>] {
  const [state, setState] = useState<CopyState>("idle");
  const announce = useAnnounce();

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2_500);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      const markup = html?.();
      if (markup && typeof ClipboardItem === "function" && typeof navigator.clipboard?.write === "function") {
        const item = new ClipboardItem({
          "text/html": new Blob([markup], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        });
        await navigator.clipboard.write([item]);
      } else await navigator.clipboard.writeText(text);
      setState("copied");
      announce("Kopierat");
    } catch {
      setState("failed");
      announce("Det gick inte att kopiera. Markera texten och kopiera den själv.");
    }
  }
  return [state, copy];
}

/**
 * Copies text and confirms it with a check in place of the copy icon and, once, "Kopierat" to a screen reader. The words
 * stay, so the button keeps its width and its neighbours stay where they are; a copy that fails says so in words.
 */
export function CopyButton({
  text,
  label,
  name,
  variant = "secondary",
  size,
  isDisabled,
}: {
  text: string;
  /** The visible words. */
  label: string;
  /** What the button is called when that says more than its words ("Kopiera transkriberingen"); it starts with them. */
  name?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  isDisabled?: boolean;
}) {
  const [state, copy] = useCopy(text);
  const words = state === "failed" ? "Kunde inte kopiera" : label;
  return (
    <Button
      variant={variant}
      size={size}
      isDisabled={isDisabled}
      icon={<Icon icon={state === "copied" ? "check" : "copy"} />}
      label={state === "failed" ? words : (name ?? label)}
      onClick={copy}
    >
      {words}
    </Button>
  );
}
