import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The visible reason a control is disabled. Render it next to the control and point the control at it with
 * aria-describedby, so the reason is text on the screen and in the accessible name, not only a title attribute.
 */
export function DisabledReason({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return <p id={id} className={cn("text-sm text-fg-muted", className)}>{children}</p>;
}
