// Hook timing at plan time (research note docs/engine/RESEARCH_SHORT_FORM_2026-10.md, section 4). The plan gate checks the shots that
// carry the script's hook beat against two platform windows: the proposition starts inside thresholds.hook.windowMs, and a hook starts
// by thresholds.hook.latestMs. Both are gate checks. The longest shot is a hypothesis, so it is reported as a note from
// planTimingNotesOf and never fails the gate: a scored or guessed figure is a score until a calibration report says otherwise.

import { thresholds } from "../../config/thresholds.ts";
import type { GateCheck, ProductionRequest, ScenePlan, ShotSpec } from "../../contracts/index.ts";
import { check, notEvaluated } from "./common.ts";

export type HookTiming = { checks: GateCheck[]; failingShotIds: string[] };

/** The two hook checks, and the shots that fail them. A late hook names the hook's own shots, so only they go back to the planner. */
export function hookTimingOf(plan: ScenePlan, request: ProductionRequest): HookTiming {
  const windowMs = thresholds.hook.windowMs.value;
  const latestMs = thresholds.hook.latestMs.value;

  if (request.script === undefined) {
    const why = "the request has no script to find the hook beat in";
    return { checks: [notEvaluated("hook_within_window", why), notEvaluated("hook_by_latest", why)], failingShotIds: [] };
  }

  const hookBeatIds = new Set(request.script.beats.filter((beat) => beat.role === "hook").map((beat) => beat.beatId));
  if (hookBeatIds.size === 0) {
    const why = "the script has no hook beat";
    return { checks: [check("hook_within_window", false, { detail: why }), check("hook_by_latest", false, { detail: why })], failingShotIds: [] };
  }

  const hookShots = plan.shots.filter((shot) => hookBeatIds.has(shot.beatId));
  if (hookShots.length === 0) {
    const why = "no shot covers the hook beat";
    return { checks: [check("hook_within_window", false, { detail: why }), check("hook_by_latest", false, { detail: why })], failingShotIds: [] };
  }

  const startMs = Math.min(...hookShots.map((shot) => shot.startMs));
  const withinWindow = startMs <= windowMs;
  const byLatest = startMs <= latestMs;
  const failingShotIds = withinWindow && byLatest ? [] : hookShots.map((shot) => shot.shotId);

  return {
    checks: [
      check("hook_within_window", withinWindow, {
        value: startMs,
        limit: windowMs,
        detail: withinWindow ? undefined : `the hook starts at ${startMs} ms, after the ${windowMs} ms window`,
      }),
      check("hook_by_latest", byLatest, {
        value: startMs,
        limit: latestMs,
        detail: byLatest ? undefined : `the hook starts at ${startMs} ms, after the latest hook at ${latestMs} ms`,
      }),
    ],
    failingShotIds,
  };
}

/** Notes the plan gate does not fail on: each shot that runs longer than the hypothesised maximum, with its length. */
export function planTimingNotesOf(plan: ScenePlan): string[] {
  const maxMs = thresholds.hook.maxShotMs.value;
  return plan.shots
    .filter((shot: ShotSpec) => shot.endMs - shot.startMs > maxMs)
    .map((shot) => `shot ${shot.shotId} runs ${shot.endMs - shot.startMs} ms, longer than ${maxMs} ms (a hypothesis, not a gate check)`);
}
