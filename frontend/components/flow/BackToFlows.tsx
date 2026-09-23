"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { MouseEvent } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The way back to the flow list, named the same on every page. Quiet by default; `flush` pulls it left by its
 * own padding (sm's px-3) so the arrow lines up with the page's edge. An action row may give it more weight.
 */
export function BackToFlows({
  onLeave,
  flush = false,
  variant = "ghost",
  size = "sm",
  className,
}: {
  /** Asked before leaving; call preventDefault to stay. */
  onLeave?: (event: MouseEvent) => void;
  flush?: boolean;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}) {
  return (
    <Button asChild variant={variant} size={size} className={cn("w-fit", flush && "-ml-3", className)}>
      <Link href="/flows" onClick={onLeave}>
        <ArrowLeft data-icon="inline-start" aria-hidden />
        Alla flöden
      </Link>
    </Button>
  );
}
