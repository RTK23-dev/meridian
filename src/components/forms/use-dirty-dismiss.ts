import { useState } from "react";
import { closeDecision } from "./form-rules";

/**
 * Close handling for a dialog or sheet that holds a form. A clean form closes at once. A dirty form stays open and shows
 * the discard prompt, so Escape, the close button and an outside click all ask first. Pass the result's requestOpenChange
 * as the dialog's onOpenChange, and use discard for the explicit Discard action.
 */
export function useDirtyDismiss({ dirty, onOpenChange, onDiscard }: {
  dirty: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resets the form to its saved values. */
  onDiscard: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  function requestOpenChange(next: boolean) {
    if (next) {
      setConfirming(false);
      onOpenChange(true);
      return;
    }
    if (closeDecision(dirty) === "confirm-discard") {
      setConfirming(true);
      return;
    }
    onOpenChange(false);
  }

  function discard() {
    setConfirming(false);
    onDiscard();
    onOpenChange(false);
  }

  return { confirming, setConfirming, requestOpenChange, discard };
}
