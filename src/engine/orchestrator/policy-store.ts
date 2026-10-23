// The orchestrator's policy for a workspace (migration 0114; owner direction 2026-10-23): the model families switched off, and the overrun
// tolerance on budgets. Every read and write is scoped to the organization. The stored JSON is validated here on every read and write, and a
// missing key takes its initial value, so an adjustment is one row update. Browser-safe for the schema and the types: no Node-only imports.

import { z } from "zod";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { INITIAL_DISABLED_MODEL_FAMILIES, normalizeModelId } from "../config/model-policy.ts";
import { INITIAL_BUDGET_TOLERANCE, type BudgetTolerance } from "../budget/tolerance.ts";

/** A family is a vendor, or a vendor and a model prefix, as OpenRouter writes ids (for example google/veo). */
const familySchema = z.string().min(2).max(120).regex(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/i, "a family is a vendor, or a vendor/model prefix");

export const orchestratorPolicySchema = z
  .object({
    disabledModelFamilies: z.array(familySchema).max(20),
    budgetTolerance: z
      .object({
        percent: z.number().finite().min(0).max(100),
        cents: z.number().finite().min(0).max(10000),
      })
      .strict(),
  })
  .strict();

export type OrchestratorPolicy = z.infer<typeof orchestratorPolicySchema>;

export const INITIAL_POLICY: OrchestratorPolicy = {
  disabledModelFamilies: [...INITIAL_DISABLED_MODEL_FAMILIES],
  budgetTolerance: { ...INITIAL_BUDGET_TOLERANCE },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The policy from a stored object. Each missing key takes its initial value. A stored object that does not validate is replaced by the
 * initial policy as a whole, so a malformed row never turns a family on. Pure.
 */
export function policyFrom(stored: unknown): OrchestratorPolicy {
  const candidate = { ...INITIAL_POLICY, ...(isRecord(stored) ? stored : {}) };
  const parsed = orchestratorPolicySchema.safeParse(candidate);
  return parsed.success ? parsed.data : { disabledModelFamilies: [...INITIAL_DISABLED_MODEL_FAMILIES], budgetTolerance: { ...INITIAL_BUDGET_TOLERANCE } };
}

function parseStored(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function readOrchestratorPolicy(sql: Sql, organizationId: string): Promise<OrchestratorPolicy> {
  const rows = await sql<{ policy_json: string | null }>`
    select policy::text as policy_json from orchestrator_policies where organization_id = ${organizationId} limit 1
  `;
  return policyFrom(parseStored(rows[0]?.policy_json));
}

/**
 * Applies a partial change and stores the whole policy. Family ids are normalized (lowercase, no leading ~). A change that does not
 * validate throws and writes nothing. Returns the stored policy.
 */
export async function writeOrchestratorPolicy(
  sql: Sql,
  input: { organizationId: string; actorId: string; patch: { disabledModelFamilies?: string[]; budgetTolerance?: BudgetTolerance } },
): Promise<OrchestratorPolicy> {
  const current = await readOrchestratorPolicy(sql, input.organizationId);
  const families = input.patch.disabledModelFamilies?.map(normalizeModelId);
  const next = orchestratorPolicySchema.parse({
    ...current,
    ...(families !== undefined ? { disabledModelFamilies: families } : {}),
    ...(input.patch.budgetTolerance !== undefined ? { budgetTolerance: input.patch.budgetTolerance } : {}),
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
