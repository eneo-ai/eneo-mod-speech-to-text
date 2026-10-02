"use client";

import type { MouseEvent } from "react";
import { Brand } from "@/components/Brand";

/**
 * The brand in a page's top bar (ModuleShell's `heading`): the organisation's mark and the product's name, a link to
 * the flows unless there is nothing to go back to.
 */
export function HeaderBrand({
  onLeave,
  linked = true,
}: {
  /** Asked before the brand's link leaves the page; call preventDefault to stay. */
  onLeave?: (event: MouseEvent) => void;
  /** Whether the brand links to the flows; not before sign-in, nor while leaving would abort an upload. */
  linked?: boolean;
}) {
  return <Brand href={linked ? "/flows" : undefined} onClickCapture={onLeave} />;
}
