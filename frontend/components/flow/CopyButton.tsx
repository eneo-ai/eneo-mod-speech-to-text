"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";

/** Copies text and confirms "Kopierat" on the button and, once, to a screen reader. */
export function CopyButton({
  text,
  label,
  ...props
}: { text: string; label: string } & Omit<ButtonProps, "onClick" | "children">) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2_500);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <>
      <Button type="button" variant="outline" {...props} onClick={copy}>
        {state === "copied" ? <Check data-icon="inline-start" aria-hidden /> : <Copy data-icon="inline-start" aria-hidden />}
        {state === "copied" ? "Kopierat" : state === "failed" ? "Kunde inte kopiera" : label}
      </Button>
      <span role="status" className="sr-only">
        {state === "copied"
          ? "Kopierat"
          : state === "failed"
            ? "Det gick inte att kopiera. Markera texten och kopiera den själv."
            : ""}
      </span>
    </>
  );
}
