import { cn } from "./cn";
import { GlobeSvg } from "./globe";

/**
 * The loading mark: the meridian globe turning. It is always labelled. The label is the status name for a reader, and
 * showLabel also shows it beside the mark. With reduced motion on, the mark rests as the still globe.
 */
export function LoadingMark({ size, label, showLabel = false, className }: { size: 16 | 24 | 48; label: string; showLabel?: boolean; className?: string }) {
  return <span role="status" aria-label={label} className={cn("inline-flex items-center gap-2 text-fg", className)}>
    <GlobeSvg size={size} animated />
    {showLabel ? <span className="text-small text-fg-secondary">{label}</span> : null}
  </span>;
}
