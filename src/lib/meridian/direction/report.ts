// The direction report of a script (framework 3.1 and 15, item 8): every finding of the slop and attention checks, the two floors, and the
// measured timeline. A script with a blocking finding is not ready: the writer revises it, or a person decides. The floors are the
// framework's gates: the trust floor fails on bait, an unpaid promise or a loop that never closes; the originality floor fails on a hook
// that repeats one of the brand's recent hooks. A floor whose input is missing (no hook history given) is "not_checked", never a pass.
//
// Pure. The brand's recent hooks are read by the caller (content-factory/hook-history-store.ts).

import { hookSimilarity, SIMILAR_HOOK_THRESHOLD } from "../content-factory/hook-history.ts";
import { attentionFindings, type AttentionMetrics, type TimedBeat } from "./attention.ts";
import { DIRECTION_CODEX_VERSION, DIRECTION_WINDOWS, type CheckId, type DirectionWindows } from "./codex.ts";
import { craftFindings } from "./craft.ts";
import { factFindings } from "./facts.ts";
import { slopFindings, type ScriptFinding, type Severity } from "./slop.ts";
import type { DirectedScript } from "./script.ts";

export type FloorState = "pass" | "fail" | "not_checked";

export type DirectionReport = {
  codexVersion: string;
  /** True when any finding blocks. */
  blocked: boolean;
  floors: { trust: FloorState; originality: FloorState };
  findings: ScriptFinding[];
  counts: Record<Severity, number>;
  metrics: AttentionMetrics;
  timeline: TimedBeat[];
};

/** The checks whose blocking finding fails the trust floor. */
export const TRUST_CHECKS: readonly CheckId[] = ["engagement_bait", "promise_paid", "loops_close", "forbidden_term"];
/** The checks whose blocking finding fails the originality floor. */
export const ORIGINALITY_CHECKS: readonly CheckId[] = ["hook_repeat"];

const SEVERITY_ORDER: Record<Severity, number> = { block: 0, warn: 1, info: 2 };

/** The script's hook: the first hook beat's voice, or its on-screen text when it has no voice. Null when there is none. */
export function hookLine(script: DirectedScript): string | null {
  const beat = script.beats.find((candidate) => candidate.role === "hook");
  if (!beat) return null;
  const line = beat.voice.trim() || (beat.onScreenText ?? "").trim();
  return line.length > 0 ? line : null;
}

/** A finding when the hook repeats, or nearly repeats, one of the brand's recent hooks. */
export function hookRepeatFindings(script: DirectedScript, recentHooks: readonly string[]): ScriptFinding[] {
  const line = hookLine(script);
  if (line === null) return [];
  let closest: { hook: string; similarity: number } | null = null;
  for (const hook of recentHooks) {
    const similarity = hookSimilarity(line, hook);
    if (!closest || similarity > closest.similarity) closest = { hook, similarity };
  }
  if (!closest || closest.similarity < SIMILAR_HOOK_THRESHOLD) return [];
  return [
    {
      check: "hook_repeat",
      severity: "block",
      evidence: "hypothesis",
      beatId: script.beats.find((beat) => beat.role === "hook")?.beatId,
      message: `The hook is ${Math.round(closest.similarity * 100)}% alike in wording to a recent hook of the brand ("${closest.hook}"). Write a new hook.`,
    },
  ];
}

export type ReportOptions = {
  windows?: Partial<DirectionWindows>;
  wordsPerMinute?: number;
  /** The brand's recent hooks. Pass an empty list when the brand has none; leave it out when they were not read. */
  recentHooks?: readonly string[];
  /** The longest the video may run. */
  maxDurationMs?: number;
  /** The brand's forbidden terms. */
  forbidden?: readonly string[];
  /** Everything the brief gives: its text, its sources and the approved claims. Leave it out and the number check is not run. */
  facts?: string;
};

/**
 * The report of one script. Leave `recentHooks` out when they were not read: the originality floor is then not checked, never passed.
 */
export function directionReport(script: DirectedScript, options: ReportOptions = {}): DirectionReport {
  const attention = attentionFindings(script, { windows: options.windows, wordsPerMinute: options.wordsPerMinute });
  const findings = [
    ...attention.findings,
    ...craftFindings(script, attention.timeline, { ...DIRECTION_WINDOWS, ...options.windows }),
    ...slopFindings(script.beats, script.language),
    ...factFindings(script, { durationMs: attention.metrics.durationMs, maxDurationMs: options.maxDurationMs, forbidden: options.forbidden, facts: options.facts }),
    ...(options.recentHooks ? hookRepeatFindings(script, options.recentHooks) : []),
  ];
  const beatOrder = new Map(script.beats.map((beat, index) => [beat.beatId, index]));
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.beatId === undefined ? -1 : (beatOrder.get(a.beatId) ?? 0)) - (b.beatId === undefined ? -1 : (beatOrder.get(b.beatId) ?? 0)),
  );

  const blocks = findings.filter((finding) => finding.severity === "block");
  const counts: Record<Severity, number> = { block: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;

  return {
    codexVersion: DIRECTION_CODEX_VERSION,
    blocked: blocks.length > 0,
    floors: {
      trust: blocks.some((finding) => TRUST_CHECKS.includes(finding.check)) ? "fail" : "pass",
      originality: options.recentHooks === undefined ? "not_checked" : blocks.some((finding) => ORIGINALITY_CHECKS.includes(finding.check)) ? "fail" : "pass",
    },
    findings,
    counts,
    metrics: attention.metrics,
    timeline: attention.timeline,
  };
}

/** The findings a writer must fix, as numbered lines for a revision prompt: blocks first, then warnings. Info is left out. */
export function revisionNotes(report: DirectionReport, limit = 12): string[] {
  return report.findings
    .filter((finding) => finding.severity !== "info")
    .slice(0, limit)
    .map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.message}`);
}
