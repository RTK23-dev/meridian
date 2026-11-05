// Seeded randomness for the direction pipeline, so a run can be replayed: the same seed gives the same deck, the same pair order and the
// same display order. FNV-1a turns the seed text into a number; mulberry32 turns that into a sequence. Not for security. Pure.

/** A generator of numbers in [0, 1), fixed by its seed. */
export function seededRandom(seed: string): () => number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** A copy of the list in a seeded order (Fisher-Yates). */
export function shuffled<T>(items: readonly T[], seed: string): T[] {
  const random = seededRandom(`shuffle:${seed}`);
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [out[index], out[other]] = [out[other]!, out[index]!];
  }
  return out;
}
