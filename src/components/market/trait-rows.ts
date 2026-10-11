export type TraitRow = { trait: string; count: number };

/** Turns stored trait counts into chart rows. Non-finite counts are dropped rather than drawn as zero. */
export function traitRows(traits: Record<string, number>): TraitRow[] {
  return Object.entries(traits)
    .filter(([, count]) => Number.isFinite(count))
    .map(([trait, count]) => ({ trait: trait.replace(/_/g, " "), count }))
    .sort((left, right) => right.count - left.count || left.trait.localeCompare(right.trait));
}
