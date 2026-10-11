/**
 * Single-key shortcuts as a pure state machine. The shell feeds it key events; it returns the next state and at most one
 * action. Typing targets and modifier keys are filtered by the caller, which passes `ignore: true`.
 */

export const CHORD_WINDOW_MS = 900;

/**
 * Shortcuts must not fire while the user types: in a text field, a select or a content-editable region. Checked by shape,
 * not by `instanceof HTMLElement`, so the rule runs outside the browser too.
 */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const element = target as { isContentEditable?: unknown; tagName?: unknown };
  if (element.isContentEditable === true) return true;
  return typeof element.tagName === "string" && ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName.toUpperCase());
}

export type ChordTarget = "overview" | "studio" | "reviews" | "intelligence" | "learning" | "factory" | "accounts";

const CHORDS: Record<string, ChordTarget> = {
  o: "overview",
  s: "studio",
  r: "reviews",
  i: "intelligence",
  l: "learning",
  f: "factory",
  a: "accounts",
};

export type ShortcutAction = { kind: "navigate"; target: ChordTarget } | { kind: "palette" } | { kind: "help" };
export type ShortcutState = { chordStartedAt: number | null };

export const INITIAL_SHORTCUT_STATE: ShortcutState = { chordStartedAt: null };

export function nextShortcutState(
  state: ShortcutState,
  input: { key: string; now: number; ignore: boolean },
): { state: ShortcutState; action: ShortcutAction | null } {
  if (input.ignore) return { state: INITIAL_SHORTCUT_STATE, action: null };
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  const chordOpen = state.chordStartedAt !== null && input.now - state.chordStartedAt < CHORD_WINDOW_MS;
  if (chordOpen) {
    const target = CHORDS[key];
    if (target) return { state: INITIAL_SHORTCUT_STATE, action: { kind: "navigate", target } };
  }
  if (key === "g") return { state: { chordStartedAt: input.now }, action: null };
  if (key === "/") return { state: INITIAL_SHORTCUT_STATE, action: { kind: "palette" } };
  if (key === "?") return { state: INITIAL_SHORTCUT_STATE, action: { kind: "help" } };
  return { state: INITIAL_SHORTCUT_STATE, action: null };
}

/**
 * Where a chord goes. Brand screens need a brand in the route; without one the chord does nothing, and "g o" goes to
 * the workspace overview.
 */
export function chordPath(target: ChordTarget, brandId?: string): string | null {
  if (target === "overview") return brandId ? `/brands/${brandId}` : "/";
  return brandId ? `/brands/${brandId}/${target}` : null;
}
