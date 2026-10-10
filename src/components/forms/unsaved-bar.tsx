import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";

/**
 * The "Unsaved changes" bar. It shows only while the form is dirty. Discard asks once, so a stray click cannot throw
 * edits away. The parent owns the confirm state, so a dialog can open the same prompt when Escape is pressed.
 */
export function UnsavedChangesBar({ dirty, subject, confirming, onConfirmingChange, onDiscard, className }: {
  dirty: boolean;
  /** The thing being edited, for the discard question, such as "brain" or "product". */
  subject: string;
  confirming: boolean;
  onConfirmingChange: (confirming: boolean) => void;
  onDiscard: () => void;
  className?: string;
}) {
  if (!dirty) return null;
  return (
    <div
      role="status"
      className={cn("flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning bg-warning-soft p-3 text-sm", className)}
    >
      <span className="font-semibold">{confirming ? `Discard your unsaved ${subject} changes?` : "Unsaved changes"}</span>
      {confirming ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="md" onClick={() => onConfirmingChange(false)}>Continue editing</Button>
          <Button type="button" variant="danger" size="md" onClick={onDiscard}>Discard changes</Button>
        </div>
      ) : (
        <Button type="button" variant="secondary" size="md" onClick={() => onConfirmingChange(true)}>Discard changes</Button>
      )}
    </div>
  );
}
