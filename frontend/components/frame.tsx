import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * The page frame, the one owner of every page's width. The header's band spans the window and its content sits
 * in FRAME, the container every page's content sits in, so each page's left edge is the brand's.
 * The workspace width is FRAME's own: the flow list, a flow's setup and its results.
 * FRAME_WIDTH is the frame without its gutters, for a view that brings its own.
 */
export const FRAME_WIDTH = "mx-auto w-full max-w-[1180px]";
export const FRAME = cn(FRAME_WIDTH, "px-4 md:px-8");

/** A flow's page from laptops: the flow and its details in a narrow column beside the working card. */
export const FLOW_GRID = "lg:grid lg:grid-cols-[20rem_minmax(0,1fr)] lg:gap-10";

/** One column read top to bottom (progress, sign-in, a flow's states), at a calm line length on FRAME's left edge. */
export const READING = "w-full max-w-2xl";

/** A view read top to bottom, in the frame. */
export function ReadingMain({ className, children, ...props }: ComponentProps<"main">) {
  return (
    <main {...props} className={cn(FRAME, "flex flex-1 flex-col pb-10 pt-2 lg:pt-8")}>
      <div className={cn(READING, "flex flex-col", className)}>{children}</div>
    </main>
  );
}
