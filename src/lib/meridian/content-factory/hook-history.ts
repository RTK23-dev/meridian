// The hooks a brand's started videos opened with, and where they repeat. A person choosing the next video needs to see when a hook has
// already been used, and when it is only worded differently. Pure: the database read is in hook-history-store.ts.
//
// A hook is the beat with role "hook" in the script a run was made from: the engine's written script, or the script lines the person sent.
// Nothing is inferred. A run with no hook beat has no recorded hook, and it is counted as such. Similarity is word overlap, a heuristic:
// it says two hooks are worded alike, not that they do the same job for the audience. The person reads the hooks before they decide.

/** Two hooks are similar when they share at least this share of their words (Jaccard, after lower-casing and dropping punctuation). */
export const SIMILAR_HOOK_THRESHOLD = 0.6;

export type HookRecord = { sessionId: string; title: string; startedAt: string | null; hook: string };

export type RepeatedHook = {
  /** "same": every record has the same wording. "similar": the records are linked by similar wording (a chain counts). */
  kind: "same" | "similar";
  /** The newest record's hook, as written. */
  hook: string;
  /** Newest first. Always two or more. */
  records: HookRecord[];
};

export type HookHistory = {
  /** Started videos of the brand, including those with no recorded hook yet. */
  started: number;
  /** Started videos with a recorded hook. */
  hooked: number;
  repeats: RepeatedHook[];
};

/** A hook's words in lower case, with punctuation and spacing reduced to single spaces. */
export function normalizeHook(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function wordsOf(text: string): Set<string> {
  return new Set(normalizeHook(text).split(" ").filter((word) => word.length > 0));
}

/** How alike two hooks are, from 0 to 1. Identical wording after normalising is 1; no shared word is 0. */
export function hookSimilarity(a: string, b: string): number {
  const normalizedA = normalizeHook(a);
  const normalizedB = normalizeHook(b);
  if (normalizedA.length === 0 || normalizedB.length === 0) return 0;
  if (normalizedA === normalizedB) return 1;
  const wordsA = wordsOf(a);
  const wordsB = wordsOf(b);
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared += 1;
  return shared / (wordsA.size + wordsB.size - shared);
}

/** The hook of a script's beats: the first beat with role "hook" and some words. Null when there is none. */
export function hookOfBeats(beats: readonly { role: string; text: string }[]): string | null {
  for (const beat of beats) {
    if (beat.role === "hook" && normalizeHook(beat.text).length > 0) return beat.text.trim();
  }
  return null;
}

function newestFirst(a: HookRecord, b: HookRecord): number {
  const timeA = a.startedAt ?? "";
  const timeB = b.startedAt ?? "";
  if (timeA !== timeB) return timeA < timeB ? 1 : -1;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

/**
 * The groups of records whose hooks repeat. Two records are linked when their hooks are similar, and a group is every record linked to one
 * another, directly or through a chain of similar hooks. A group of one is not a repeat and is not returned. Groups are ordered by size.
 */
export function repeatedHooks(records: readonly HookRecord[]): RepeatedHook[] {
  const parent = records.map((_, index) => index);
  const root = (index: number): number => {
    let current = index;
    while (parent[current] !== current) current = parent[current] ?? current;
    return current;
  };
  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      if (hookSimilarity(records[i]?.hook ?? "", records[j]?.hook ?? "") >= SIMILAR_HOOK_THRESHOLD) {
        parent[root(i)] = root(j);
      }
    }
  }
  const groups = new Map<number, HookRecord[]>();
  records.forEach((record, index) => {
    const key = root(index);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  });
  const repeats: RepeatedHook[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort(newestFirst);
    const wordings = new Set(sorted.map((record) => normalizeHook(record.hook)));
    repeats.push({ kind: wordings.size === 1 ? "same" : "similar", hook: sorted[0]?.hook ?? "", records: sorted });
  }
  return repeats.sort((a, b) => b.records.length - a.records.length || newestFirst(a.records[0] as HookRecord, b.records[0] as HookRecord));
}

/** The history a person reads: how many videos started, how many have a hook, and which hooks repeat. */
export function hookHistoryOf(started: readonly { sessionId: string; title: string; startedAt: string | null; hook: string | null }[]): HookHistory {
  const records: HookRecord[] = [];
  for (const item of started) {
    if (item.hook !== null) records.push({ sessionId: item.sessionId, title: item.title, startedAt: item.startedAt, hook: item.hook });
  }
  return { started: started.length, hooked: records.length, repeats: repeatedHooks(records) };
}
