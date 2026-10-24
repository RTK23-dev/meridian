// Content governance (prompt 18): what a brand intends to post, how well its delivered videos score, and whether the material behind a video
// is covered by rights. The rules are pure, so they can be read and checked without a database. A pillar's share is a target a person sets,
// not a fact the system infers. A quality score is a person's judgement against the rubric the brand chose. A rights gate blocks an
// approval; it never approves anything itself.

export const PILLAR_NAME_MAX = 80;
export const RUBRIC_NAME_MAX = 80;
export const RUBRIC_CRITERIA_MAX = 8;
export const CRITERION_NAME_MAX = 60;
export const CRITERION_WEIGHT_MIN = 1;
export const CRITERION_WEIGHT_MAX = 5;
export const SCORE_MIN = 1;
export const SCORE_MAX = 5;
export const CADENCE_MIN = 1;
export const CADENCE_MAX = 14;
export const RIGHTS_TEXT_MAX = 500;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The first problem with a pillar, in plain words, or null. The shares of the other pillars are passed so the total stays within 100%. */
export function pillarProblem(input: { name: string; targetShare: number | null }, otherShares: readonly number[]): string | null {
  const name = input.name.trim();
  if (name.length === 0) return "Give the pillar a name.";
  if (name.length > PILLAR_NAME_MAX) return `The pillar name is longer than ${PILLAR_NAME_MAX} characters.`;
  if (input.targetShare === null) return null;
  if (!Number.isFinite(input.targetShare) || input.targetShare <= 0 || input.targetShare > 100) {
    return "A pillar's share is a percentage above 0 and at most 100.";
  }
  const total = otherShares.reduce((sum, share) => sum + share, 0) + input.targetShare;
  if (total > 100 + 1e-9) return `The pillars' shares would add up to ${round1(total)}%, more than 100%. Lower this share or another pillar's.`;
  return null;
}

export type PillarMixRow = { pillarId: string | null; name: string; targetShare: number | null; started: number; sharePercent: number | null };

/**
 * How the started videos of a brand fall across its pillars. A share is a percentage of the started videos; it is null while none has started,
 * so a brand with no videos reads as unknown, not as zero. Videos with no pillar are counted in their own row.
 */
export function pillarMix(
  pillars: ReadonlyArray<{ id: string; name: string; targetShare: number | null }>,
  videos: ReadonlyArray<{ pillarId: string | null; started: boolean }>,
): PillarMixRow[] {
  const counts = new Map<string | null, number>();
  for (const video of videos) {
    if (video.started) counts.set(video.pillarId, (counts.get(video.pillarId) ?? 0) + 1);
  }
  return pillarMixOfCounts(pillars, [...counts].map(([pillarId, started]) => ({ pillarId, started })));
}

/**
 * The same mix from counts of started videos per pillar. The counts are read in the database over every video of the brand, so a brand with
 * many videos is not cut to the rows a screen lists.
 */
export function pillarMixOfCounts(
  pillars: ReadonlyArray<{ id: string; name: string; targetShare: number | null }>,
  counts: ReadonlyArray<{ pillarId: string | null; started: number }>,
): PillarMixRow[] {
  const total = counts.reduce((sum, row) => sum + row.started, 0);
  const share = (count: number): number | null => (total === 0 ? null : round1((count / total) * 100));
  const countOf = (pillarId: string | null): number => counts.filter((row) => row.pillarId === pillarId).reduce((sum, row) => sum + row.started, 0);
  const rows: PillarMixRow[] = pillars.map((pillar) => {
    const count = countOf(pillar.id);
    return { pillarId: pillar.id, name: pillar.name, targetShare: pillar.targetShare, started: count, sharePercent: share(count) };
  });
  const unassigned = countOf(null);
  if (unassigned > 0 || rows.length === 0) {
    rows.push({ pillarId: null, name: "Not in a pillar", targetShare: null, started: unassigned, sharePercent: share(unassigned) });
  }
  return rows;
}

export type CadenceStatus =
  | { status: "unset" }
  | { status: "on_track" | "behind" | "ahead"; target: number; actual: number };

/** The cadence compares the videos started in the last seven days with the target the brand set. Null target is not set. */
export function cadenceStatus(videosPerWeek: number | null, startedInLastSevenDays: number): CadenceStatus {
  if (videosPerWeek === null) return { status: "unset" };
  const status = startedInLastSevenDays < videosPerWeek ? "behind" : startedInLastSevenDays === videosPerWeek ? "on_track" : "ahead";
  return { status, target: videosPerWeek, actual: startedInLastSevenDays };
}

export function cadenceProblem(videosPerWeek: number): string | null {
  if (!Number.isInteger(videosPerWeek) || videosPerWeek < CADENCE_MIN || videosPerWeek > CADENCE_MAX) {
    return `The cadence is a whole number of videos a week, from ${CADENCE_MIN} to ${CADENCE_MAX}.`;
  }
  return null;
}

export type RubricCriterion = { name: string; weight: number };

export function criteriaProblem(criteria: readonly RubricCriterion[]): string | null {
  if (criteria.length === 0) return "A rubric needs at least one criterion.";
  if (criteria.length > RUBRIC_CRITERIA_MAX) return `A rubric has at most ${RUBRIC_CRITERIA_MAX} criteria.`;
  const names = new Set<string>();
  for (const criterion of criteria) {
    const name = criterion.name.trim();
    if (name.length === 0) return "Each criterion needs a name.";
    if (name.length > CRITERION_NAME_MAX) return `A criterion name is longer than ${CRITERION_NAME_MAX} characters.`;
    if (names.has(name)) return `The criterion "${name}" is listed twice.`;
    names.add(name);
    if (!Number.isInteger(criterion.weight) || criterion.weight < CRITERION_WEIGHT_MIN || criterion.weight > CRITERION_WEIGHT_MAX) {
      return `The weight of "${name}" is a whole number from ${CRITERION_WEIGHT_MIN} to ${CRITERION_WEIGHT_MAX}.`;
    }
  }
  return null;
}

/** Every criterion needs a whole score from 1 to 5, and no score may name a criterion the rubric does not have. */
export function scoresProblem(criteria: readonly RubricCriterion[], scores: Record<string, number>): string | null {
  const known = new Set(criteria.map((criterion) => criterion.name.trim()));
  for (const name of Object.keys(scores)) {
    if (!known.has(name)) return `"${name}" is not a criterion of this rubric.`;
  }
  for (const criterion of criteria) {
    const name = criterion.name.trim();
    const value = scores[name];
    if (value === undefined) return `Score "${name}".`;
    if (!Number.isInteger(value) || value < SCORE_MIN || value > SCORE_MAX) return `The score for "${name}" is a whole number from ${SCORE_MIN} to ${SCORE_MAX}.`;
  }
  return null;
}

/** The weighted mean of the scores, from 1 to 5, rounded to two places. Only valid scores may reach it (see scoresProblem). */
export function weightedTotal(criteria: readonly RubricCriterion[], scores: Record<string, number>): number {
  let sum = 0;
  let weights = 0;
  for (const criterion of criteria) {
    const name = criterion.name.trim();
    sum += criterion.weight * (scores[name] ?? 0);
    weights += criterion.weight;
  }
  return Math.round((sum / weights) * 100) / 100;
}

export type RightsInput = { subject: string; holder: string; permittedUse: string; validUntil: string | null };

/** The first problem with a rights record, or null. A record's end date may not be in the past when it is made. */
export function rightsProblem(input: RightsInput, today: string): string | null {
  if (input.subject.trim().length === 0) return "Say what material the record covers.";
  if (input.holder.trim().length === 0) return "Say who holds the rights.";
  if (input.permittedUse.trim().length === 0) return "Say what use the holder permits.";
  if (input.subject.trim().length > 200 || input.holder.trim().length > 200) return "The subject and the holder are at most 200 characters each.";
  if (input.permittedUse.trim().length > RIGHTS_TEXT_MAX) return `The permitted use is at most ${RIGHTS_TEXT_MAX} characters.`;
  if (input.validUntil !== null) {
    if (!ISO_DATE.test(input.validUntil)) return "The end date is a date, such as 2027-06-30.";
    if (input.validUntil < today) return "The end date has already passed. A record that has ended cannot cover new videos.";
  }
  return null;
}

export type RightsRecordFacts = { id: string; attachmentId: string | null; validUntil: string | null; revoked: boolean };
export type FileReference = { attachmentId: string; fileName: string };

/** A record that names the file, has not been revoked, and has not ended on the given day. */
function coversFile(record: RightsRecordFacts, file: FileReference, today: string): boolean {
  return record.attachmentId === file.attachmentId && !record.revoked && (record.validUntil === null || record.validUntil >= today);
}

/**
 * The rights gate of an approval. Every stored file a video was made from needs a rights record that names that file, has not been revoked,
 * and has not ended. A file with none is named in the result, and the approval is blocked. The gate only blocks; it never approves.
 */
export function rightsGate(
  files: readonly FileReference[],
  records: readonly RightsRecordFacts[],
  today: string,
): { ok: true } | { ok: false; missing: string[] } {
  const missing = files.filter((file) => !records.some((record) => coversFile(record, file, today))).map((file) => file.fileName);
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * The rights record that covers each file, for an approval to name. Only meaningful once rightsGate has passed: a file with no covering record
 * contributes nothing.
 */
export function coveringRightsRecordIds(files: readonly FileReference[], records: readonly RightsRecordFacts[], today: string): string[] {
  return files.flatMap((file) => {
    const record = records.find((candidate) => coversFile(candidate, file, today));
    return record ? [record.id] : [];
  });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
