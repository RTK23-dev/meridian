// The `take` gate (Bible 6.7 step 4, 12.2, 5.3). Pure: the measurements, the similarity results, the Critic's outcome and the
// gold metrics are passed in as data, and the gate never reads a store or the network. It returns the GateResult the
// orchestrator routes and the TakeVerdict the check_take job reports (Bible 4.3). Both agree: the verdict's pass is the gate's.
//
// Routing (Bible 5.3, 12.4):
// - every check passes: accept.
// - a check has no evidence (a missing measurement, a scorer that is not connected, a Critic with no answer), or the Critic is
//   unsure (confidence below the escalation threshold): escalate to review. Missing evidence is never a pass and never a block.
// - measured failures only, and one of them has a gold set that meets the accuracy target: redo, with the failing rules as
//   hints. The gold set is the only reason to block (12.4).
// - measured failures with no gold set that meets the target: escalate to review.
// The downgrade after two redos is the orchestrator's (Bible 5.3); this gate never returns "downgrade".

import type { GateCheck, GateResult } from "../../contracts/gate.ts";
import { idSchema } from "../../contracts/ids.ts";
import { EngineError } from "../../contracts/errors.ts";
import { takeVerdictSchema, type TakeVerdict } from "../../contracts/take.ts";
import { gateResult } from "./common.ts";
import { criticRows, type CriticOutcome } from "../critic.ts";
import { codeRows } from "../take/code.ts";
import { similarityRows } from "../take/similarity.ts";
import {
  takeShotSchema,
  type SimilarityKind,
  type SimilarityOutcome,
  type TakeGoldMetrics,
  type TakeRow,
  type TakeShot,
} from "../take/types.ts";

export type TakeAction = TakeVerdict["action"];

export type TakeGateInput = {
  /** The take's id (take_). */
  takeId: string;
  /** The shot the take was made for. Parsed here; an unreadable shot is an invalid_input, because it is plan data, not evidence. */
  shot: unknown;
  /** The take's measurements (see take/code.ts). Parsed there; an unreadable object makes the code checks missing. */
  measurements: unknown;
  /** Similarity results by kind (see take/similarity.ts). A required kind without a result is missing evidence. */
  similarity: Partial<Record<SimilarityKind, SimilarityOutcome>>;
  /** The Critic's outcome (see critic.ts). */
  critic: CriticOutcome;
  /** Gold-set metrics by gold-set key. A key with no metrics, or with metrics that miss the target, cannot block. */
  metrics: TakeGoldMetrics;
};

export type TakeGateOutcome = {
  /** The gate result for the orchestrator (gate "take", subjectId the take id). Its pass equals verdict.pass. */
  gate: GateResult;
  /** The verdict check_take reports (Bible 4.3). */
  verdict: TakeVerdict;
  /** Rules whose failure is proven by a gold set that meets the target. These are the reason to redo. */
  provenFailures: string[];
  /** Measured failures without a proven gold set, and escalations (the Critic's confidence). */
  unprovenFailures: string[];
  /** Checks with no evidence. */
  missing: string[];
  /** One line for the review item and the log, built from rule names only. */
  reason: string;
};

function toTakeCheck(item: GateCheck): TakeVerdict["checks"][number] {
  return {
    rule: item.rule,
    pass: item.pass,
    ...(item.value === undefined ? {} : { score: item.value }),
    ...(item.detail === undefined ? {} : { detail: item.detail }),
  };
}

/** A Critic with no answer has no confidence. 0 is the value that makes the take escalate; its rubric row says why. */
function confidenceOf(critic: CriticOutcome): number {
  return critic.status === "answered" ? critic.confidence : 0;
}

function actionOf(pass: boolean, hasMissing: boolean, hasEscalation: boolean, hasProven: boolean): TakeAction {
  if (pass) return "accept";
  if (hasMissing || hasEscalation) return "escalate";
  return hasProven ? "redo" : "escalate";
}

function reasonOf(action: TakeAction, missing: string[], unproven: string[], proven: string[]): string {
  if (action === "accept") return "every take check passes";
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`not evaluated: ${missing.join(", ")}`);
  if (unproven.length > 0) parts.push(`failing without a proven gold set: ${unproven.join(", ")}`);
  if (proven.length > 0) parts.push(`failing with a proven gold set: ${proven.join(", ")}`);
  return `${action}: ${parts.join("; ")}`;
}

/** The take gate. Throws invalid_input only for a shot or a take id that is not valid; every evidence problem is a row. */
export function takeGate(input: TakeGateInput): TakeGateOutcome {
  const takeId = idSchema("take_").safeParse(input.takeId);
  if (!takeId.success) {
    throw new EngineError("invalid_input", "the take gate needs a take_ id", { stage: "check_take" });
  }
  const shotParsed = takeShotSchema.safeParse(input.shot);
  if (!shotParsed.success) {
    throw new EngineError("invalid_input", "the take gate needs a valid shot from the plan", { stage: "check_take" });
  }
  const shot: TakeShot = shotParsed.data;

  const rows: TakeRow[] = [
    ...codeRows(shot, input.measurements),
    ...similarityRows(shot, input.similarity),
    ...criticRows(input.critic),
  ];

  const failing = rows.filter((row) => !row.check.pass);
  const missing: TakeRow[] = [];
  const escalation: TakeRow[] = [];
  const proven: TakeRow[] = [];
  const unproven: TakeRow[] = [];
  for (const row of failing) {
    if (row.evidence === "missing") {
      missing.push(row);
    } else if (row.gold === null) {
      escalation.push(row);
      unproven.push(row);
    } else if (input.metrics[row.gold]?.meetsTarget === true) {
      proven.push(row);
    } else {
      unproven.push(row);
    }
  }

  const pass = failing.length === 0;
  const action = actionOf(pass, missing.length > 0, escalation.length > 0, proven.length > 0);
  const ruleNames = (list: TakeRow[]): string[] => list.map((row) => row.check.rule);

  const checks = rows.map((row) => row.check);
  const gate = gateResult("take", takeId.data, checks, pass ? [] : [shot.shotId]);
  const verdict = takeVerdictSchema.parse({
    takeId: takeId.data,
    pass,
    confidence: confidenceOf(input.critic),
    checks: checks.map(toTakeCheck),
    action,
  });

  return {
    gate,
    verdict,
    provenFailures: ruleNames(proven),
    unprovenFailures: ruleNames(unproven),
    missing: ruleNames(missing),
    reason: reasonOf(action, ruleNames(missing), ruleNames(unproven), ruleNames(proven)),
  };
}

/**
 * The best passing take of a shot's round (Bible 6.7 step 4): the passing verdict with the highest confidence, the lower take id
 * on a tie. Null when no take passed. The orchestrator orders its round the same way.
 */
export function pickBestTake(verdicts: readonly TakeVerdict[]): TakeVerdict | null {
  const passing = verdicts.filter((verdict) => verdict.pass);
  if (passing.length === 0) return null;
  const sorted = [...passing].sort((a, b) => b.confidence - a.confidence || a.takeId.localeCompare(b.takeId));
  return sorted[0] ?? null;
}
