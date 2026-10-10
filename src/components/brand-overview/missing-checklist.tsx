import { Link } from "@tanstack/react-router";
import { ArrowRight, Circle } from "lucide-react";
import { Card } from "@/components/ui";
import type { MissingItem } from "./pipeline";

/** Gaps in the stored data as a short checklist. Each row links to the screen that fills it. */
export function MissingChecklist({ brandId, items }: { brandId: string; items: MissingItem[] }) {
  return (
    <Card aria-labelledby="missing-title" className="space-y-3">
      <h2 id="missing-title" className="text-base font-semibold text-fg">What is missing</h2>
      {items.length ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {items.map((item) => (
            <li key={item.text}>
              <Link
                to={item.to}
                params={{ brandId }}
                className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-border px-3 text-sm font-medium text-fg transition-colors hover:border-accent"
              >
                <span className="flex items-center gap-2">
                  <Circle aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
                  {item.text}
                </span>
                <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-accent" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-muted">No pipeline gaps are visible in the stored brand data.</p>
      )}
    </Card>
  );
}
