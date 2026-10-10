import { Badge } from "@/components/ui";
import { ageBadge, confidenceBadge, formatOpened, reviewPriority, type ReviewRow } from "./review-model";

/**
 * The list of open reviews. Each row carries an age badge, a priority badge and a confidence badge, all as text, so no
 * state is shown by colour alone. The selected row is marked with aria-current.
 */
export function ReviewInbox({
  items,
  selectedIndex,
  now,
  onSelect,
}: {
  items: readonly ReviewRow[];
  selectedIndex: number;
  now: Date;
  onSelect: (index: number) => void;
}) {
  return (
    <section aria-label="Review inbox">
      <ul className="space-y-2">
        {items.map((item, index) => {
          const age = ageBadge(item.createdAt, now);
          const priority = reviewPriority({ createdAt: item.createdAt, confidence: item.confidence, now });
          const confidence = confidenceBadge(item.confidence);
          const selected = index === selectedIndex;
          return (
            <li key={item.id}>
              <button
                id={`review-option-${item.id}`}
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(index)}
                className={`flex min-h-11 w-full flex-col gap-2 rounded-lg border p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${selected ? "border-accent bg-surface-2" : "border-border bg-surface"}`}
              >
                <span className="block truncate font-semibold">{item.label || "Untitled review"}</span>
                <span className="block text-xs text-muted">{formatOpened(item.createdAt)} · {item.decision} · {item.question}</span>
                <span className="flex flex-wrap gap-1.5">
                  <Badge variant={age.tone}>{age.label}</Badge>
                  <Badge variant={priority.high ? "warning" : "neutral"}>{priority.label}</Badge>
                  <Badge variant={confidence.tone}>{confidence.label}</Badge>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
