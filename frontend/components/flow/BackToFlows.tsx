"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { MouseEvent } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The way back to the flow list, named the same on every page: a soft filled pill that reads as a button at
 * rest, its edge on the page's edge. An action row may give it more weight.
 */
export function BackToFlows({
  onLeave,
  variant = "secondary",
  size = "sm",
  className,
}: {
  /** Asked before leaving; call preventDefault to stay. */
  onLeave?: (event: MouseEvent) => void;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}) {
  return (
    <Button asChild variant={variant} size={size} className={cn("w-fit", className)}>
      <Link href="/flows" onClick={onLeave}>
        <ArrowLeft data-icon="inline-start" aria-hidden />
        Alla flöden
      </Link>
    </Button>
  );
}
