/**
 * The cost mode a production run is routed with. The settings panel saves it, the studio routes with it, and the
 * summary reports it. All three call the same functions, so the setting shown is the one a run uses.
 *
 * Order: the workspace's saved cost preference, then the deployment's PRODUCTION_COST_PREFERENCE, then BALANCED, which is
 * what production has always used. A value that is not a router mode is never used.
 */
import type { Sql } from "../learning/store.ts";
import { CREDENTIAL_VAULT_TYPE } from "../credentials/contract.ts";
import { retrieveVaultCredential } from "../vault/service.ts";
import type { CostMode } from "./types.ts";

export const COST_MODES: readonly CostMode[] = ["ZERO_SPEND", "LOWEST_COST", "BALANCED", "QUALITY_FIRST"];

export function isCostMode(value: unknown): value is CostMode {
  return typeof value === "string" && (COST_MODES as readonly string[]).includes(value);
}

/** The mode for a saved value, the deployment's default, or BALANCED. Pure. */
export function resolveCostMode(saved: unknown, env: Record<string, string | undefined> = process.env): CostMode {
  if (isCostMode(saved)) return saved;
  const deployment = env.PRODUCTION_COST_PREFERENCE?.trim();
  return isCostMode(deployment) ? deployment : "BALANCED";
}

/**
 * The mode a production run for this organization is routed with. A saved entry that cannot be read contributes nothing,
 * so the run uses the deployment default, which is the mode production has always used.
 */
export async function productionCostMode(
  sql: Sql | undefined,
  organizationId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<CostMode> {
  if (!sql || !organizationId.trim()) return resolveCostMode(undefined, env);
  const rows = await sql<{ id: string }>`
    select id from credential_vault
    where organization_id = ${organizationId} and credential_type = ${CREDENTIAL_VAULT_TYPE.production}
    limit 1
  `;
  if (!rows[0]) return resolveCostMode(undefined, env);
  try {
    const payload = await retrieveVaultCredential(sql, organizationId, rows[0].id);
    return resolveCostMode(payload?.customFields?.costPreference, env);
  } catch {
    return resolveCostMode(undefined, env);
  }
}
