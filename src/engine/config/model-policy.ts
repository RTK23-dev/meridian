// The model policy: which model families the engine and the orchestrator may choose (owner direction, 2026-10-23: Veo stays off for now).
// These are initial values. Each workspace's list is stored and adjustable in Settings (orchestrator policy, migration 0114), so turning a
// family on is a setting, not a code change. A family is a prefix of the listing's id, so one family covers every version of a model line.

/** The families switched off until the owner turns them on. An initial value, adjustable per workspace. */
export const INITIAL_DISABLED_MODEL_FAMILIES: readonly string[] = ["google/veo"];

/** A model id or family in one form: lowercase, with the leading ~ that marks a live alias removed. */
export function normalizeModelId(id: string): string {
  return id.trim().replace(/^~/, "").toLowerCase();
}

/** Whether a model id belongs to a family that is switched off. */
export function isDisabledModel(id: string, families: readonly string[]): boolean {
  const normalized = normalizeModelId(id);
  return families.some((family) => {
    const prefix = normalizeModelId(family);
    return prefix.length > 0 && normalized.startsWith(prefix);
  });
}

/** The entries no switched-off family covers, in their own order. Pure. */
export function allowedByFamilies<T extends { id: string }>(entries: readonly T[], families: readonly string[]): T[] {
  return entries.filter((entry) => !isDisabledModel(entry.id, families));
}
