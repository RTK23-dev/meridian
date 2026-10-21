import { Link } from "@tanstack/react-router";
import { cn } from "./cn";
import { GlobeSvg } from "./globe";

/** The still meridian globe as the home link. With wordmark, "Meridian" in the display face sits beside it. */
export function Mark({ size = 28, wordmark = false, className }: { size?: number; wordmark?: boolean; className?: string }) {
  return <Link to="/" aria-label="Meridian, go to Home" className={cn("inline-flex items-center gap-2 rounded-sharp text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent", className)}>
    <GlobeSvg size={size} />
    {wordmark ? <span className="font-display text-heading font-semibold">Meridian</span> : null}
  </Link>;
}
