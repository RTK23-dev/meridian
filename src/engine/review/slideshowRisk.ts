// Slideshow risk (Bible 12.3): six dimensions, each 0 to 1, and a weighted mean that must be below thresholds.postRender.slideshowRiskMax.
// Pure: the plan's shots, the EDL's effects and the script's beats are passed in. Two checks come out of it:
//   - slideshow_coded_run: no run of coded shots (source kind component) longer than thresholds.edit.sameShotTypeMaxRun. The Bible's
//     acceptance test, "five coded shots in a row is blocked", is this check, and the same limit the edit rules give a shot type.
//   - slideshow_risk_below_max: the weighted mean of the six dimensions is below the limit.
// The dimensions are measured from the plan, the EDL and the script, so they are evidence the gate can read. Their definitions and
// the weights are initial (review/tuning.ts), and no check built on them blocks until its gold set meets the target (Bible 12.4).

import type { EditDecisionList, ScriptBeat, ShotSpec } from "../contracts/index.ts";
import { thresholds } from "../config/thresholds.ts";
import type { GateCheck } from "../contracts/gate.ts";
import { check, notEvaluated, stringsIn } from "./gates/common.ts";
import { REVIEW_TUNING } from "./tuning.ts";

export const SLIDESHOW_DIMENSIONS = [
  "repetition",
  "decorative_visuals",
  "weak_motion",
  "shot_intent",
  "typography_over_reliance",
  "unsupported_cinematic_claims",
] as const;
export type SlideshowDimension = (typeof SLIDESHOW_DIMENSIONS)[number];

export type DimensionScore = {
  dimension: SlideshowDimension;
  /** 0 (no problem) to 1 (the whole plan has it). */
  value: number;
  /** The shots that carry the problem, in time order. */
  shotIds: string[];
  detail: string;
};

export type SlideshowInput = {
  /** The plan's shots (ScenePlan.shots). Any order; they are sorted by time here. */
  shots: readonly ShotSpec[];
  /** The EDL's effects, for the motion dimension. */
  edl: Pick<EditDecisionList, "effects">;
  /** The script's beats, for decorative visuals and shot intent. */
  beats: readonly ScriptBeat[];
};

export type SlideshowResult = {
  dimensions: DimensionScore[];
  /** The weighted mean, or null when the plan has no shots (nothing to judge). */
  mean: number | null;
  codedRun: { longest: number; limit: number; shotIds: string[] };
  checks: GateCheck[];
  /** The shots that carry a failing problem (a long coded run, or the dimensions when the mean is over the limit). */
  failingShotIds: string[];
};

const MOTION_KINDS = new Set<string>(REVIEW_TUNING.motionEffectKinds);
const STILL_CLASSES = new Set<string>(REVIEW_TUNING.stillModelClasses);
const TEXT_LED = new Set<string>(REVIEW_TUNING.textLedComponents);
const CLAIM_TYPES = new Set<string>(REVIEW_TUNING.cinematicClaimTypes);
const STOP_WORDS = new Set<string>(REVIEW_TUNING.stopWords);

function sortedByTime(shots: readonly ShotSpec[]): ShotSpec[] {
  return [...shots].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || (a.shotId < b.shotId ? -1 : a.shotId > b.shotId ? 1 : 0));
}

function durationOf(shot: ShotSpec): number {
  return shot.endMs - shot.startMs;
}

function isPresenter(shot: ShotSpec): boolean {
  return shot.visualType === "ugc_presenter";
}

function isCoded(shot: ShotSpec): boolean {
  return shot.source.kind === "component";
}

/** Consecutive runs of shots that join: next to the previous shot, with the same key. A presenter shot never joins a run. */
function runsOf(shots: readonly ShotSpec[], joins: (previous: ShotSpec, next: ShotSpec) => boolean): ShotSpec[][] {
  const runs: ShotSpec[][] = [];
  for (const shot of shots) {
    const current = runs[runs.length - 1];
    const last = current?.[current.length - 1];
    if (current !== undefined && last !== undefined && joins(last, shot)) {
      current.push(shot);
    } else {
      runs.push([shot]);
    }
  }
  return runs;
}

const sameTypeJoins = (previous: ShotSpec, next: ShotSpec): boolean =>
  !isPresenter(previous) && !isPresenter(next) && previous.visualType === next.visualType;
const codedJoins = (previous: ShotSpec, next: ShotSpec): boolean => isCoded(previous) && isCoded(next);

/** The text a shot carries for its words: the component's props, the generation prompt, or the stock query. */
function shotText(shot: ShotSpec): string {
  switch (shot.source.kind) {
    case "component":
      return stringsIn(shot.source.props).join(" ");
    case "generate":
      return shot.source.prompt;
    case "stock":
      return shot.source.query;
    case "asset":
      return "";
  }
}

function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return new Set(words.filter((word) => word.length >= REVIEW_TUNING.contentWordMinLength && !STOP_WORDS.has(word)));
}

function isMotionEffectIn(shot: ShotSpec, effects: EditDecisionList["effects"]): boolean {
  return effects.some((effect) => effect.atMs >= shot.startMs && effect.atMs < shot.endMs && MOTION_KINDS.has(effect.kind));
}

function isStill(shot: ShotSpec): boolean {
  if (shot.source.kind === "asset") return true;
  return shot.source.kind === "generate" && STILL_CLASSES.has(shot.source.modelClass);
}

function isMovingFootage(shot: ShotSpec): boolean {
  if (shot.source.kind === "stock") return true;
  return shot.source.kind === "generate" && shot.source.modelClass.startsWith(REVIEW_TUNING.motionModelClassPrefix);
}

function share(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** The six dimensions, each from the plan, the EDL and the script (Bible 12.3). */
export function slideshowDimensions(input: SlideshowInput): DimensionScore[] {
  const shots = sortedByTime(input.shots);
  const total = shots.length;
  const totalMs = shots.reduce((sum, shot) => sum + durationOf(shot), 0);
  const typeLimit = thresholds.edit.sameShotTypeMaxRun;
  const codedLimit = REVIEW_TUNING.codedRunMax;
  const beatById = new Map<string, string>();
  for (const beat of input.beats) beatById.set(beat.beatId, `${beatById.get(beat.beatId) ?? ""} ${beat.text}`);
  const beatIds = new Set(input.beats.map((beat) => beat.beatId));

  // Repetition: the shots in a same-type run longer than the 8.3 type limit, or a coded run longer than the coded limit, as a share of
  // the shots.
  const longRuns = (joins: typeof sameTypeJoins, limit: number): ShotSpec[] =>
    runsOf(shots, joins)
      .filter((run) => run.length > limit)
      .flat();
  const repeated = [
    ...new Set([...longRuns(sameTypeJoins, typeLimit), ...longRuns(codedJoins, codedLimit)].map((shot) => shot.shotId)),
  ];
  const repetitionShots = shots.filter((shot) => repeated.includes(shot.shotId));

  // Decorative visuals: a non-presenter shot whose text shares no content word with its beat, and that has no must request.
  const decorative = shots.filter((shot) => {
    if (isPresenter(shot)) return false;
    if ((shot.mustSatisfy ?? "").trim().length > 0) return false;
    const beat = contentWords(beatById.get(shot.beatId) ?? "");
    const own = contentWords(shotText(shot));
    return ![...own].some((word) => beat.has(word));
  });
  const nonPresenter = shots.filter((shot) => !isPresenter(shot)).length;

  // Weak motion: the share of time in still shots with no motion effect inside them.
  const still = shots.filter((shot) => isStill(shot) && !isMotionEffectIn(shot, input.edl.effects));

  // Shot intent: a shot whose beat is not in the script has no purpose the script states.
  const orphans = shots.filter((shot) => !beatIds.has(shot.beatId));

  // Typography over-reliance: the share of time where the picture is text.
  const textLed = shots.filter((shot) => shot.visualType === "kinetic_type" || (shot.source.kind === "component" && TEXT_LED.has(shot.source.component)));

  // Unsupported cinematic claims: a shot that says cinematic or stock footage, but its source is not moving footage.
  const claimed = shots.filter((shot) => CLAIM_TYPES.has(shot.visualType));
  const unsupported = claimed.filter((shot) => !isMovingFootage(shot));

  const noBeats = input.beats.length === 0;
  const timeShare = (list: readonly ShotSpec[]): number => share(list.reduce((sum, shot) => sum + durationOf(shot), 0), totalMs);

  const repetitionValue = total === 0 ? 0 : share(repetitionShots.length, total);
  const decorativeValue = share(decorative.length, nonPresenter);
  const stillValue = timeShare(still);
  const intentValue = noBeats ? 1 : share(orphans.length, total);
  const typographyValue = timeShare(textLed);
  const cinematicValue = share(unsupported.length, claimed.length);

  return [
    {
      dimension: "repetition",
      value: round(repetitionValue),
      shotIds: repetitionShots.map((shot) => shot.shotId),
      detail: `${repetitionShots.length} of ${total} shots sit in a run of one shot type longer than ${typeLimit}, or of coded shots longer than ${codedLimit}`,
    },
    {
      dimension: "decorative_visuals",
      value: round(decorativeValue),
      shotIds: decorative.map((shot) => shot.shotId),
      detail: `${decorative.length} of ${nonPresenter} non-presenter shots share no word with their beat and have no must request`,
    },
    {
      dimension: "weak_motion",
      value: round(stillValue),
      shotIds: still.map((shot) => shot.shotId),
      detail: `${round(stillValue * 100)}% of the time is still shots with no motion effect`,
    },
    {
      dimension: "shot_intent",
      value: round(intentValue),
      shotIds: orphans.map((shot) => shot.shotId),
      detail: noBeats ? "the request has no script beats, so no shot has a stated purpose" : `${orphans.length} of ${total} shots belong to no script beat`,
    },
    {
      dimension: "typography_over_reliance",
      value: round(typographyValue),
      shotIds: textLed.map((shot) => shot.shotId),
      detail: `${round(typographyValue * 100)}% of the time is text-led (kinetic type or a text component)`,
    },
    {
      dimension: "unsupported_cinematic_claims",
      value: round(cinematicValue),
      shotIds: unsupported.map((shot) => shot.shotId),
      detail: `${unsupported.length} of ${claimed.length} cinematic or stock shots have a still source, not moving footage`,
    },
  ];
}

/** The weighted mean of the dimensions, or null when there is nothing to judge. */
export function weightedMean(dimensions: readonly DimensionScore[]): number | null {
  const weights = REVIEW_TUNING.slideshowWeights;
  const weightSum = dimensions.reduce((sum, item) => sum + weights[item.dimension], 0);
  if (dimensions.length === 0 || weightSum <= 0) return null;
  const weighted = dimensions.reduce((sum, item) => sum + item.value * weights[item.dimension], 0);
  return round(weighted / weightSum);
}

/** Runs the slideshow risk checks on a plan. Pure. */
export function slideshowRisk(input: SlideshowInput): SlideshowResult {
  const shots = sortedByTime(input.shots);
  const limit = REVIEW_TUNING.codedRunMax;
  const runs = runsOf(shots, codedJoins).filter((run) => run[0] !== undefined && isCoded(run[0]));
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const overRun = runs.filter((run) => run.length > limit).flat().map((shot) => shot.shotId);
  const codedRun = { longest, limit, shotIds: [...new Set(overRun)] };

  const checks: GateCheck[] = [];
  checks.push(
    check("slideshow_coded_run", longest <= limit, {
      value: longest,
      limit,
      detail:
        longest <= limit
          ? `the longest run of coded shots is ${longest}, within ${limit}`
          : `${longest} coded shots in a row; the limit is ${limit} (Bible 12.3: five in a row is blocked)`,
    }),
  );

  if (shots.length === 0) {
    checks.push(notEvaluated("slideshow_risk_below_max", "the plan has no shots to judge"));
    return { dimensions: [], mean: null, codedRun, checks, failingShotIds: codedRun.shotIds };
  }

  const dimensions = slideshowDimensions(input);
  const mean = weightedMean(dimensions);
  const max = thresholds.postRender.slideshowRiskMax.value;
  if (mean === null) {
    checks.push(notEvaluated("slideshow_risk_below_max", "the dimension weights sum to nothing"));
  } else {
    const pass = mean < max;
    const breakdown = dimensions.map((item) => `${item.dimension} ${item.value.toFixed(3)}`).join(", ");
    checks.push(
      check("slideshow_risk_below_max", pass, {
        value: mean,
        limit: max,
        detail: `weighted mean ${mean.toFixed(3)} must be below ${max} (${breakdown})`,
      }),
    );
  }

  const contributing = dimensions.filter((item) => item.value > 0).flatMap((item) => item.shotIds);
  const meanFails = mean === null || mean >= max;
  const failingShotIds = [...new Set([...codedRun.shotIds, ...(meanFails ? contributing : [])])];
  return { dimensions, mean, codedRun, checks, failingShotIds };
}
