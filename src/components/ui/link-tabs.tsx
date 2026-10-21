import { Link } from "@tanstack/react-router";
import { cn } from "./cn";

/** Tabs that are links, so the URL carries the tab. The active tab has a 2px red underline on the list's hairline. */
export function LinkTabs({ items, activeTo, label = "Sections", className }: { items: Array<{ to: string; label: string }>; activeTo: string; label?: string; className?: string }) {
  return <nav aria-label={label} className={cn("flex max-w-full gap-1 overflow-x-auto border-b border-hairline", className)}>
    {items.map((item) => {
      const active = item.to === activeTo;
      return <Link key={item.to} to={item.to} aria-current={active ? "page" : undefined} className={cn("relative inline-flex min-h-10 shrink-0 items-center px-3 text-button font-semibold hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent pointer-coarse:min-h-11", active ? "text-fg" : "text-fg-secondary")}>
        {item.label}
        <span aria-hidden="true" className={cn("absolute inset-x-0 -bottom-px h-0.5", active ? "bg-accent" : "bg-transparent")} />
      </Link>;
    })}
  </nav>;
}
