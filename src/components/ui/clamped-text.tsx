import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "./cn";

/**
 * A paragraph shown at most `lines` lines high, with "Show more" when the words run longer, so a page's opening reads at a glance instead
 * of as a wall. The full text stays in the page for a screen reader; only its height is limited on the screen.
 */
export function ClampedText({ children, lines = 2, className }: { children: ReactNode; lines?: 2 | 3; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children, open]);
  return (
    <div className="space-y-1">
      <p ref={ref} id={id} className={cn(className, open ? null : lines === 2 ? "line-clamp-2" : "line-clamp-3")}>{children}</p>
      {overflows || open ? (
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="min-h-8 rounded-full text-small font-semibold text-fg-primary underline underline-offset-4 hover:no-underline">
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
