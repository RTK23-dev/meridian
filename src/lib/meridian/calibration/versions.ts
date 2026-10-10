/**
 * Read-only helpers for the calibration screen: the active threshold baseline, the evidence stored with each proposal,
 * and the difference between a proposal and the baseline. Nothing here approves, applies or stores a change.
 */
import { isoTimestamp } from "../observability/timestamps.ts";

export type ThresholdPair = { autoApprove: number; humanReview: number };

/**
 * The thresholds the decision path uses. "approved" is the highest-version row. "code_default" applies when no row exists.
 * "unreadable" means the highest row cannot be parsed. The decision path then falls back to the code default, and this
 * shows that fallback with the version that could not be read.
 */
export type Baseline =
  | { source: "approved"; version: number; thresholds: ThresholdPair }
  | { source: "code_default"; version: null; thresholds: ThresholdPair }
  | { source: "unreadable"; version: number; thresholds: ThresholdPair };

export type ThresholdChange = {
  field: keyof ThresholdPair;
  baseline: number;
  proposed: number;
  /** proposed minus baseline, rounded to three places. */
  change: number;
  changed: boolean;
};

export type CalibrationProposalView = {
  id: string;
  status: string;
  createdAt: string;
  evidence: { samples: number | null; disagreement: number | null };
  proposed: ThresholdPair | null;
  /** The baseline the proposal was computed from. Null when the stored record cannot be read. */
  recordedBaseline: ThresholdPair | null;
  /** True when the active baseline has changed since the proposal was made. Null when the recorded baseline is unknown. */
  baselineChanged: boolean | null;
  /** Proposed minus active baseline. Null when the proposed thresholds cannot be read. */
  changes: ThresholdChange[] | null;
  /** Only proposals still waiting for a decision can be approved or rejected. */
  canDecide: boolean;
  /** The version approval would write if it happened against the active baseline now. Approval recomputes it. */
  nextVersionIfApproved: number;
};

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A pair is readable only when both thresholds are finite numbers. */
export function thresholdPair(value: unknown): ThresholdPair | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const autoApprove = finiteOrNull(record.autoApprove);
  const humanReview = finiteOrNull(record.humanReview);
  if (autoApprove === null || humanReview === null) return null;
  return { autoApprove, humanReview };
}

/** Parses a stored threshold JSON string (jev_threshold_versions.thresholds). */
export function parseThresholds(raw: unknown): ThresholdPair | null {
  return thresholdPair(parseJsonObject(raw));
}

/** Evidence stored with a proposal. Fields that are missing or not numbers stay null. Nothing is estimated. */
export function proposalEvidence(raw: unknown): {
  samples: number | null;
  disagreement: number | null;
  current: ThresholdPair | null;
  proposed: ThresholdPair | null;
} {
  const parsed = parseJsonObject(raw) ?? {};
  return {
    samples: finiteOrNull(parsed.samples),
    disagreement: finiteOrNull(parsed.disagreement),
    current: thresholdPair(parsed.current),
    proposed: thresholdPair(parsed.proposed),
  };
}

/** `versions` may be in any order. The highest version is the active one, as the decision path reads it. */
export function activeBaseline(versions: readonly { version: number; thresholds: unknown }[], codeDefault: ThresholdPair): Baseline {
  if (versions.length === 0) return { source: "code_default", version: null, thresholds: codeDefault };
  const latest = versions.reduce((best, row) => (row.version > best.version ? row : best));
  const thresholds = parseThresholds(latest.thresholds);
  if (!thresholds) return { source: "unreadable", version: latest.version, thresholds: codeDefault };
  return { source: "approved", version: latest.version, thresholds };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function thresholdChanges(baseline: ThresholdPair, proposed: ThresholdPair): ThresholdChange[] {
  return (["autoApprove", "humanReview"] as const).map((field) => ({
    field,
    baseline: baseline[field],
    proposed: proposed[field],
    change: round3(proposed[field] - baseline[field]),
    changed: proposed[field] !== baseline[field],
  }));
}

/** Exact match of both thresholds. Null when the recorded baseline is unknown. */
export function sameThresholds(recorded: ThresholdPair | null, active: ThresholdPair): boolean | null {
  if (!recorded) return null;
  return recorded.autoApprove === active.autoApprove && recorded.humanReview === active.humanReview;
}

export function calibrationProposalView(
  row: { id: string; status: string; created_at: unknown; proposed: unknown },
  baseline: Baseline,
): CalibrationProposalView {
  const evidence = proposalEvidence(row.proposed);
  const same = sameThresholds(evidence.current, baseline.thresholds);
  return {
    id: row.id,
    status: row.status,
    createdAt: isoTimestamp(row.created_at),
    evidence: { samples: evidence.samples, disagreement: evidence.disagreement },
    proposed: evidence.proposed,
    recordedBaseline: evidence.current,
    baselineChanged: same === null ? null : !same,
    changes: evidence.proposed ? thresholdChanges(baseline.thresholds, evidence.proposed) : null,
    canDecide: row.status === "proposed",
    nextVersionIfApproved: (baseline.version ?? 0) + 1,
  };
}
