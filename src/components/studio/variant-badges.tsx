import { StatusBadge } from "@/components/ui";

/** QA, review and creative status. Each badge carries an icon and a word, so the state is not carried by colour alone. */
export function VariantStatusBadges({ qa, review, creative }: { qa: string; review: string; creative: string }) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Variant status">
      <li><StatusBadge status={qa || "pending"} label="QA" /></li>
      <li><StatusBadge status={review || "unknown"} label="Review" /></li>
      <li><StatusBadge status={creative || "unknown"} label="Creative" /></li>
    </ul>
  );
}
