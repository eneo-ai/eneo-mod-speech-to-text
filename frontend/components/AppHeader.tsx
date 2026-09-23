import type { MouseEvent } from "react";
import { AccountMenu } from "@/components/AccountMenu";
import { Brand } from "@/components/Brand";
import { FRAME } from "@/components/frame";
import { cn } from "@/lib/utils";

/** The app's header: from laptops a band across the window, its brand on the frame's left edge. */
export function AppHeader({
  onLeave,
  account = true,
  className,
}: {
  /** Asked before the brand's link leaves the page; call preventDefault to stay. */
  onLeave?: (event: MouseEvent) => void;
  /** False before sign-in. */
  account?: boolean;
  className?: string;
}) {
  return (
    <header className={cn("lg:border-b lg:border-rule-soft lg:bg-paper", className)}>
      <div className={cn(FRAME, "flex min-h-16 items-center justify-between pb-6 pt-5 md:pt-7 lg:py-3")}>
        <div onClickCapture={onLeave}>
          <Brand href={account ? "/flows" : undefined} />
        </div>
        {account && <AccountMenu />}
      </div>
    </header>
  );
}
