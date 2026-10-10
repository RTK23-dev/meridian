import { BRAIN_FIELDS, type BrainKey } from "@/lib/meridian/brain";

/** A pending suggestion as getMarket returns it. Accepting one replaces the saved text of its field. */
export type BrainSuggestion = { id: string; field: string; value: string; documentId: string };

export type SuggestionListState = { kind: "empty" } | { kind: "ready"; count: number };

export function suggestionListState(suggestions: readonly BrainSuggestion[]): SuggestionListState {
  return suggestions.length === 0 ? { kind: "empty" } : { kind: "ready", count: suggestions.length };
}

/**
 * Accepting writes the saved brain. If the form has unsaved edits, a later save would overwrite the
 * accepted text, so accept waits until the form is saved or discarded.
 */
export function acceptBlockReason(formDirty: boolean): string | null {
  return formDirty
    ? "Save or discard your brain changes first. Otherwise a later save would overwrite the accepted text."
    : null;
}

/** The saved text of a field, trimmed. Empty or unknown fields read as empty, never as a guess. */
export function savedText(saved: Partial<Record<string, string>>, field: string): string {
  const known = BRAIN_FIELDS.some((entry) => entry.key === field);
  if (!known) return "";
  return (saved[field as BrainKey] ?? "").trim();
}
