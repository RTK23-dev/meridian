import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./primitives";

/** A side panel, 480px wide on desktop and the full width on phones. Esc closes it. */
export function Drawer({ open, onOpenChange, title, description, children, className }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children?: ReactNode; className?: string;
}) {
  return <Sheet open={open} onOpenChange={onOpenChange} direction="right">
    <SheetContent side="right" className={className}>
      <SheetTitle className="font-display text-section font-semibold text-fg">{title}</SheetTitle>
      {description ? <SheetDescription className="mt-1 text-small text-fg-muted">{description}</SheetDescription> : null}
      <div className="mt-6 space-y-4">{children}</div>
    </SheetContent>
  </Sheet>;
}
