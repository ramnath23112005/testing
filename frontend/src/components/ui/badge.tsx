import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase",
  {
    variants: {
      variant: {
        default: "border-solar-200 bg-solar-50 text-solar-800",
        success: "border-emerald-200 bg-emerald-50 text-emerald-700",
        warning: "border-amber-200 bg-amber-50 text-amber-800",
        destructive: "border-red-200 bg-red-50 text-red-700",
        info: "border-sky-200 bg-sky-50 text-sky-700",
        secondary: "border-slate-200 bg-slate-100 text-slate-600",
        dark: "border-navy-700 bg-navy-800 text-slate-200",
        outline: "border-slate-300 text-slate-600",
      },
      size: {
        default: "px-2 py-0.5 text-[11px]",
        sm: "px-1.5 py-0.5 text-[10px]",
        lg: "px-3 py-1 text-xs",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

export { Badge, badgeVariants };
