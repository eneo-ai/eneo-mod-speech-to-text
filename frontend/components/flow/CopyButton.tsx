"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";

export type CopyState = "idle" | "copied" | "failed";

/** Copies text; the state says "Kopierat" for a moment, or that it failed. */
export function useCopy(text: string): [CopyState, () => Promise<void>] {
  const [state, setState] = useState<CopyState>("idle");

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
  return [state, copy];
}

/** What a screen reader hears once after a copy. */
export function CopyStatus({ state }: { state: CopyState }) {
  return (
    <span role="status" className="sr-only">
      {state === "copied"
        ? "Kopierat"
        : state === "failed"
          ? "Det gick inte att kopiera. Markera texten och kopiera den själv."
          : ""}
    </span>
  );
}

/** Copies text and confirms "Kopierat" on the button and, once, to a screen reader. */
export function CopyButton({
  text,
  label,
  variant = "outline",
  ...props
}: { text: string; label: ReactNode } & Omit<ButtonProps, "onClick" | "children">) {
  const [state, copy] = useCopy(text);
  return (
    <>
      <Button type="button" variant={variant} {...props} onClick={copy}>
        {state === "copied" ? <Check data-icon="inline-start" aria-hidden /> : <Copy data-icon="inline-start" aria-hidden />}
        {state === "copied" ? "Kopierat" : state === "failed" ? "Kunde inte kopiera" : label}
      </Button>
      <CopyStatus state={state} />
    </>
  );
}
