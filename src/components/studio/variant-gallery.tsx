import { useRef, useState, type KeyboardEvent } from "react";
import { Kbd } from "@/components/ui";
import { VariantCard, type VariantActions } from "./variant-card.tsx";
import { clampIndex, studioKeyAction } from "./studio-keys.ts";
import { canReview } from "./variant-state.ts";
import type { StudioPublication, StudioVariant } from "./types.ts";

type VariantGalleryProps = {
  variants: StudioVariant[];
  canEdit: boolean;
  reviewBusyIds: readonly string[];
  publishBusyIds: readonly string[];
  publications: readonly StudioPublication[];
  actions: VariantActions;
};

function isTypingTarget(target: Element): boolean {
  return target.matches("input, textarea, select, [contenteditable='true']");
}

/**
 * The variant gallery. Keys act only when focus is inside the gallery. A review key opens the review dialog with that action;
 * the dialog then asks for the reason and note. Arrow keys move the selection and focus to the next card.
 */
export function VariantGallery({ variants, canEdit, reviewBusyIds, publishBusyIds, publications, actions }: VariantGalleryProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const sectionRef = useRef<HTMLElement | null>(null);
  const cardRefs = useRef<(HTMLLIElement | null)[]>([]);
  const index = clampIndex(selectedIndex, variants.length);

  function moveTo(next: number) {
    const target = clampIndex(next, variants.length);
    setSelectedIndex(target);
    cardRefs.current[target]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const section = sectionRef.current;
    const target = event.target;
    if (!section || !(target instanceof Element) || !section.contains(target)) return;
    const current = variants[index];
    const action = studioKeyAction({
      key: event.key,
      typing: isTypingTarget(target),
      modifier: event.metaKey || event.ctrlKey || event.altKey,
      canReview: !!current && canReview(current, canEdit),
      hasVariants: variants.length > 0,
    });
    if (action.kind === "none") return;
    event.preventDefault();
    if (action.kind === "move") {
      moveTo(index + action.by);
      return;
    }
    if (current) actions.onReview(current, action.action);
  }

  return (
    <section ref={sectionRef} aria-labelledby="studio-variants-heading" className="space-y-4" onKeyDown={onKeyDown}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id="studio-variants-heading" className="font-display text-2xl">Variants</h2>
        {variants.length > 0 ? (
          <p className="text-sm text-fg-muted">
            With a variant focused: <Kbd>A</Kbd> opens approve · <Kbd>R</Kbd> opens reject · <Kbd>V</Kbd> opens revision request · <Kbd>←</Kbd> <Kbd>→</Kbd> move between variants. The dialog asks for the reason and note before anything is sent.
          </p>
        ) : null}
      </div>
      {variants.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No media is stored yet. Generate variants in step 3. A video appears here only after its engine stores the file: Gemini Omni, Hypit, or a manual cloud file.
        </p>
      ) : null}
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {variants.map((variant, position) => (
          <VariantCard
            key={variant.assetId}
            variant={variant}
            position={position + 1}
            selected={position === index}
            canEdit={canEdit}
            reviewBusy={reviewBusyIds.includes(variant.creativeId)}
            publishBusy={publishBusyIds.includes(variant.creativeId)}
            publisherId={publications.find((item) => item.creativeId === variant.creativeId)?.externalId ?? null}
            cardRef={(node) => { cardRefs.current[position] = node; }}
            onSelect={() => setSelectedIndex(position)}
            actions={actions}
          />
        ))}
      </ul>
    </section>
  );
}
