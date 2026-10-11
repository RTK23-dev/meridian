import { sectionAnchor, type BrainSectionId } from "./brain-sections";

export type MiniNavItem = { id: BrainSectionId; label: string; filled: number; total: number };

/**
 * Left column on wide screens, a wrapping row on small ones. Each link jumps to its section and shows how many of its fields
 * have content. Choosing one reports the section, so the brain opens there next time.
 */
export function BrainMiniNav({ items, onSelect }: { items: MiniNavItem[]; onSelect?: (id: BrainSectionId) => void }) {
  return <nav aria-label="Brand brain sections" className="lg:sticky lg:top-6 lg:self-start">
    <ul className="flex flex-wrap gap-2 lg:flex-col">
      {items.map((item) => <li key={item.id} className="min-w-0 basis-[calc(50%-0.25rem)] sm:basis-[calc(33.333%-0.34rem)] lg:basis-auto lg:flex-none">
        <a
          href={`#${sectionAnchor(item.id)}`}
          onClick={() => onSelect?.(item.id)}
          className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 rounded-md border border-border bg-surface px-3 text-sm text-fg hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <span className="min-w-0 break-words font-semibold">{item.label}</span>
          <span className="tabular-nums text-fg-muted">{item.filled} of {item.total}</span>
        </a>
      </li>)}
    </ul>
  </nav>;
}
