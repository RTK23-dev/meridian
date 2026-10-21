import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes } from "react";
import { Activity, AlertCircle, CheckCircle2, Clock3, Info, PlugZap } from "lucide-react";
import { cn } from "./cn";
import { statusPresentation } from "./status-map";

/** A dot and a word. Colour is never the only signal, and no status is filled with a tint. */
const badgeVariants = cva("inline-flex h-5 items-center gap-1.5 whitespace-nowrap text-caption font-medium before:inline-block before:size-1.5 before:rounded-full before:content-['']", {
  variants: {
    variant: {
      neutral: "text-fg-secondary before:bg-fg-muted",
      success: "text-fg before:bg-success",
      warning: "text-fg before:bg-warning",
      danger: "text-danger before:bg-danger",
      info: "text-fg before:bg-info",
    },
  },
  defaultVariants: { variant: "neutral" },
});

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge({ variant, className, ...props }, ref) {
  return <span {...props} ref={ref} className={cn(badgeVariants({ variant }), className)} />;
});

/** Danger always carries an icon and a word, so it adds the alert icon. The other states use the dot. */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const presentation = statusPresentation(status);
  const icons = { activity: Activity, alert: AlertCircle, check: CheckCircle2, clock: Clock3, info: Info, plug: PlugZap };
  const Icon = icons[presentation.icon];
  return <Badge variant={presentation.variant} aria-label={`${label ? `${label}: ` : ""}${presentation.label}`}>
    {presentation.variant === "danger" ? <Icon aria-hidden="true" className="size-3.5" /> : null}
    <span>{presentation.label}</span>
  </Badge>;
}

export { badgeVariants };
