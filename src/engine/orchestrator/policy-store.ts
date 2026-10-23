// The orchestrator's policy for a workspace (migration 0114; owner direction 2026-10-23): the model families switched off, and the measure
// ceiling for measure mode (D15). The overrun tolerance is retired (D12: a budget is a line), so a stored row that still carries it is read
// without that key, and its other keys are read as they are. Every read and write is scoped to the organization. The stored JSON is validated
// here on every read and write, and both keys are required: a stored row that lacks one is unreadable, as a malformed row is. No key is filled
// in on a read, because a missing family list would switch every family back on. A workspace with no row reads the initial policy. The read
// reports an unreadable row, and planning, runs and edits refuse with its reason. Nothing is reset, and no family is switched on by it.
// Browser-safe for the schema and the types: no Node-only imports (the measure options are a type only).

import { z } from "zod";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { INITIAL_DISABLED_MODEL_FAMILIES, normalizeModelId } from "../config/model-policy.ts";
import type { MeasureOptions } from "./measure.ts";

/** A family is a vendor, or a vendor and a model prefix, as OpenRouter writes ids (for example google/veo). */
const familySchema = z.string().min(2).max(120).regex(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/i, "a family is a vendor, or a vendor/model prefix");

/**
 * The measure ceiling: the most a video or avatar step without a price is held to, per second of its length (D15). The workspace may set it
 * from one cent to five dollars a second. The initial value is a starting point, adjustable like the families.
 */
export const MEASURE_CEILING_RANGE = { min: 0.01, max: 5 } as const;
export const INITIAL_MEASURE_CEILING_USD_PER_SECOND = 0.5;
const measureCeilingSchema = z.number().finite().min(MEASURE_CEILING_RANGE.min).max(MEASURE_CEILING_RANGE.max);

export const orchestratorPolicySchema = z
  .object({
    disabledModelFamilies: z.array(familySchema).max(20),
    measureCeilingUsdPerSecond: measureCeilingSchema,
  })
  .strict();

export type OrchestratorPolicy = z.infer<typeof orchestratorPolicySchema>;

export const INITIAL_POLICY: OrchestratorPolicy = {
  disabledModelFamilies: [...INITIAL_DISABLED_MODEL_FAMILIES],
  measureCeilingUsdPerSecond: INITIAL_MEASURE_CEILING_USD_PER_SECOND,
};

/** The reason a stored row that does not validate is refused for. Planning, runs and edits give it; the policy read reports it. */
export const UNREADABLE_POLICY_REASON = "the workspace's orchestrator policy is unreadable; save the policy again";

/** The reason a save over an unreadable row gives when it does not state the model families: the stored families are not known, so none is kept. */
export const UNREADABLE_POLICY_FAMILIES_REASON = "the workspace's orchestrator policy is unreadable; state the model families when you save it again";

/** A workspace's stored policy as it is read: the policy, or that the row is unreadable, with the reason. An unreadable row is never defaulted. */
export type PolicyRead = { status: "ok"; policy: OrchestratorPolicy } | { status: "unreadable"; reason: string };

/** The key a row stored before D12 carried. It is retired: it is dropped on read, and nothing else in the row is changed by that. */
const RETIRED_TOLERANCE_KEY = "budgetTolerance";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function initialPolicy(): OrchestratorPolicy {
  return { disabledModelFamilies: [...INITIAL_POLICY.disabledModelFamilies], measureCeilingUsdPerSecond: INITIAL_POLICY.measureCeilingUsdPerSecond };
}

/**
 * The policy from a stored object. The retired key is dropped first. Every other key is required, and none is filled in: a stored value that
 * is not an object, or does not validate (a family list that is not a list, a malformed family, a ceiling out of range, a missing key, an
 * unknown key), is unreadable. The read gives its reason and no policy, so no family is reset to the initial list and none is switched on. Pure.
 */
export function policyFrom(stored: unknown): PolicyRead {
  if (!isRecord(stored)) return { status: "unreadable", reason: UNREADABLE_POLICY_REASON };
  const current = Object.fromEntries(Object.entries(stored).filter(([key]) => key !== RETIRED_TOLERANCE_KEY));
  const parsed = orchestratorPolicySchema.safeParse(current);
  return parsed.success ? { status: "ok", policy: parsed.data } : { status: "unreadable", reason: UNREADABLE_POLICY_REASON };
}

/**
 * The workspace's stored policy as it is read. A workspace with no stored row reads the initial policy: it has never saved one. A row that
 * is not JSON, or does not validate, is unreadable (policyFrom).
 */
export async function readOrchestratorPolicy(sql: Sql, organizationId: string): Promise<PolicyRead> {
  const rows = await sql<{ policy_json: string | null }>`
    select policy::text as policy_json from orchestrator_policies where organization_id = ${organizationId} limit 1
  `;
  const row = rows[0];
  if (row === undefined) return { status: "ok", policy: initialPolicy() };
  let stored: unknown;
  try {
    stored = JSON.parse(row.policy_json ?? "") as unknown;
  } catch {
    return { status: "unreadable", reason: UNREADABLE_POLICY_REASON };
  }
  return policyFrom(stored);
}

/**
 * The workspace's policy for an action that depends on it: planning, a run, a step edit, the model list. An unreadable row throws its reason
 * before anything is read from a provider or written, so nothing is planned, run or edited on a family set that cannot be read (fail closed).
 */
export async function requireOrchestratorPolicy(sql: Sql, organizationId: string): Promise<OrchestratorPolicy> {
  const read = await readOrchestratorPolicy(sql, organizationId);
  if (read.status === "unreadable") throw new Error(read.reason);
  return read.policy;
}

/**
 * Applies a partial change and stores the whole policy. Family ids are normalized (lowercase, no leading ~). A readable row keeps the value of
 * an absent field. An unreadable row has no values to keep: the save must state the families, and an absent ceiling takes its initial value.
 * A change that does not validate, the measure ceiling included, throws and writes nothing. Returns the stored policy.
 */
export async function writeOrchestratorPolicy(
  sql: Sql,
  input: { organizationId: string; actorId: string; patch: { disabledModelFamilies?: string[]; measureCeilingUsdPerSecond?: number } },
): Promise<OrchestratorPolicy> {
  const read = await readOrchestratorPolicy(sql, input.organizationId);
  const families = input.patch.disabledModelFamilies?.map(normalizeModelId);
  if (read.status === "unreadable" && families === undefined) throw new Error(UNREADABLE_POLICY_FAMILIES_REASON);
  const base = read.status === "ok" ? read.policy : initialPolicy();
  const next = orchestratorPolicySchema.parse({
    ...base,
    ...(families !== undefined ? { disabledModelFamilies: families } : {}),
    ...(input.patch.measureCeilingUsdPerSecond !== undefined ? { measureCeilingUsdPerSecond: input.patch.measureCeilingUsdPerSecond } : {}),
  });
  await sql`
    insert into orchestrator_policies (organization_id, policy, updated_by, updated_at)
    values (${input.organizationId}, ${JSON.stringify(next)}::jsonb, ${input.actorId}, now())
    on conflict (organization_id) do update set
      policy = excluded.policy,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `;
  return next;
}

/** What a run may do about measure mode (D15): off, on with the workspace's ceiling, or refused. */
export type MeasureDecision = { status: "off"; measure: null } | { status: "on"; measure: MeasureOptions } | { status: "refused"; reason: string };

/**
 * Whether a run takes measure mode. Only an admin may: a run that asks for it without the admin role is refused, and an admin's run is held to
 * the workspace's ceiling. A run that does not ask takes none, whatever the role. Pure.
 */
export function measureModeFor(policy: OrchestratorPolicy, request: { measure: boolean; admin: boolean }): MeasureDecision {
  if (!request.measure) return { status: "off", measure: null };
  if (!request.admin) return { status: "refused", reason: "Only a workspace admin may run a plan in measure mode." };
  return { status: "on", measure: { ceilingUsdPerSecond: policy.measureCeilingUsdPerSecond } };
}
