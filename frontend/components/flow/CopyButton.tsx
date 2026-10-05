import { useEffect, useState } from "react";
import { Button, type ButtonProps } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";

type CopyState = "idle" | "copied" | "failed";

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
    <VisuallyHidden role="status">
      {state === "copied"
        ? "Kopierat"
        : state === "failed"
          ? "Det gick inte att kopiera. Markera texten och kopiera den själv."
          : ""}
    </VisuallyHidden>
  );
}

/** Copies text and confirms "Kopierat" on the button and, once, to a screen reader. */
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
  const words = state === "copied" ? "Kopierat" : state === "failed" ? "Kunde inte kopiera" : label;
  return (
    <>
      <Button
        variant={variant}
        size={size}
        isDisabled={isDisabled}
        icon={<Icon icon={state === "copied" ? "check" : "copy"} />}
        label={state === "idle" ? (name ?? label) : words}
        onClick={copy}
      >
        {words}
      </Button>
      <CopyStatus state={state} />
    </>
  );
}
