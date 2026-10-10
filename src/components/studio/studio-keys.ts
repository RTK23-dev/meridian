/**
 * The studio review keys. Pure, so the mapping can be tested without a DOM. The gallery calls this from its own key handler,
 * so the keys act only when focus is inside the gallery and never while a person is typing.
 *
 * A approves, R rejects, V requests a revision. Arrow keys move between variants (left and up go back, right and down go
 * forward). Shortcuts with ctrl, meta or alt are left to the browser and the shell.
 */

import type { ReviewAction } from "./review-rules.ts";

export type StudioKeyInput = {
  key: string;
  /** Focus is in a text field, a select or an editable area. Keys are then typed text, not shortcuts. */
  typing: boolean;
  /** Ctrl, meta or alt is held. */
  modifier: boolean;
  /** The role may review, and the focused variant is waiting for review. */
  canReview: boolean;
  hasVariants: boolean;
};

export type StudioKeyAction =
  | { kind: "review"; action: ReviewAction }
  | { kind: "move"; by: 1 | -1 }
  | { kind: "none" };

export function studioKeyAction(input: StudioKeyInput): StudioKeyAction {
  if (input.typing || input.modifier) return { kind: "none" };
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (key === "a" || key === "r" || key === "v") {
    if (!input.canReview) return { kind: "none" };
    const action: ReviewAction = key === "a" ? "approve" : key === "r" ? "reject" : "revision";
    return { kind: "review", action };
  }
  if (key === "ArrowRight" || key === "ArrowDown") {
    return input.hasVariants ? { kind: "move", by: 1 } : { kind: "none" };
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return input.hasVariants ? { kind: "move", by: -1 } : { kind: "none" };
  }
  return { kind: "none" };
}

/** Keeps a list index inside the bounds of the list. An empty list stays at 0. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}
