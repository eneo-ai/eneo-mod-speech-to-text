import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// The icon sits on the title's first line: 12 px padding plus half of (20.6 px line - 16 px icon).
const alertVariants = cva(
  "relative w-full rounded-lg border px-4 py-3 text-[15px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-3.5 [&>svg]:size-4 [&>svg~*]:pl-7",
  {
    variants: {
      variant: {
        default: "bg-card text-ink [&>svg]:text-ink-soft",
        // DESIGN.md: info and warning boxes are ochre.
        warning: "border-ochre/40 bg-ochre/10 text-ink [&>svg]:text-ochre",
        destructive: "border-destructive/50 bg-card text-destructive [&>svg]:text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    role="alert"
    className={cn(alertVariants({ variant }), className)}
    {...props}
  />
))
Alert.displayName = "Alert"

// A callout's title is not a document heading, so it keeps the page outline intact.
const AlertTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("mb-1 break-words font-semibold leading-snug last:mb-0", className)}
    {...props}
  />
))
AlertTitle.displayName = "AlertTitle"

// The title carries the tone; the explanation reads in the page's own text colour.
const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("break-words leading-relaxed text-ink-soft", className)}
    {...props}
  />
))
AlertDescription.displayName = "AlertDescription"

export { Alert, AlertTitle, AlertDescription }
