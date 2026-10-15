// Shared helpers for the pure gates (Bible 12 and 5.3). A gate returns a GateResult; the orchestrator routes it.
// Unknown means fail: a check that cannot be evaluated is a failing check with a detail, never a pass.

import { EngineError, gateResultSchema, idSchema, type GateCheck, type GateId, type GateResult } from "../../contracts/index.ts";

/** The EDL frame rate (contracts/edl.ts fps is the literal 30). A test in gates.test.ts keeps the two equal. */
export const EDL_FPS = 30;

export type CheckExtra = { value?: number; limit?: number; detail?: string };

/** One check. Optional numbers are kept only when finite, and a detail only when it is non-empty. */
export function check(rule: string, pass: boolean, extra: CheckExtra = {}): GateCheck {
  const result: GateCheck = { rule, pass };
  if (extra.value !== undefined && Number.isFinite(extra.value)) {
    result.value = extra.value;
  }
  if (extra.limit !== undefined && Number.isFinite(extra.limit)) {
    result.limit = extra.limit;
  }
  if (extra.detail !== undefined && extra.detail.length > 0) {
    result.detail = extra.detail;
  }
  return result;
}

/** A check that could not run because an input it needs is missing or invalid. It fails. */
export function notEvaluated(rule: string, why: string): GateCheck {
  return check(rule, false, { detail: `not evaluated: ${why}` });
}

/**
 * Build the GateResult. pass is true only with at least one check and every check passing (contracts/primitives.ts).
 * failingShotIds is set only when given, and is de-duplicated in the order given.
 */
export function gateResult(gate: GateId, subjectId: string, checks: GateCheck[], failingShotIds: string[] = []): GateResult {
  const unique = failingShotIds.filter((id, index, all) => all.indexOf(id) === index);
  const result = {
    gate,
    subjectId,
    pass: checks.length > 0 && checks.every((item) => item.pass),
    checks,
    ...(unique.length > 0 ? { failingShotIds: unique } : {}),
  };
  const parsed = gateResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new EngineError("internal", `gate ${gate} built an invalid result: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * The ids that are plan shots (shot_), in the order given and without repeats. A rule can name a clip that is not a shot (the
 * loop clip, a sticker); such a clip is not a shot to send back to the plan, so it is left out rather than failing the result.
 */
export function asShotIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((id) => idSchema("shot_").safeParse(id).success);
}

/** Every string inside a JSON-like value, to a fixed depth. Used to find URIs inside component props. */
export function stringsIn(value: unknown, depth = 0): string[] {
  if (depth > 8) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringsIn(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap((item) => stringsIn(item, depth + 1));
  }
  return [];
}
