import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes } from "react";
import { Activity, AlertCircle, CheckCircle2, Clock3, Info, PlugZap } from "lucide-react";
import { cn } from "@/lib/cn";
import { statusPresentation } from "./status-map";

const badgeVariants = cva("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold", {
  variants: {
    variant: {
      neutral: "bg-surface-2 text-fg border border-border",
      success: "bg-success-soft text-success",
      warning: "bg-warning-soft text-warning",
      danger: "bg-danger-soft text-danger",
      info: "bg-info-soft text-info",
    },
  },
  defaultVariants: { variant: "neutral" },
});

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge({ variant, className, ...props }, ref) {
  return <span {...props} ref={ref} className={cn(badgeVariants({ variant }), className)} />;
});

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const presentation = statusPresentation(status);
  const icons = { activity: Activity, alert: AlertCircle, check: CheckCircle2, clock: Clock3, info: Info, plug: PlugZap };
  const Icon = icons[presentation.icon];
  return <Badge variant={presentation.variant} aria-label={`${label ? `${label}: ` : ""}${presentation.label}`}>
    <Icon aria-hidden="true" className="size-3.5" />
    <span>{presentation.label}</span>
  </Badge>;
}

export { badgeVariants };
