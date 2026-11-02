// The billing page's reads and writes (server side). Every limit is read from, and written to, the store that already enforces it: the monthly
// budget on the organization, the brand budget on its budget account, the factory caps on factory_spend_caps, and the measure ceiling and the
// decision cap on the workspace's orchestrator policy. The page adds no store of its own, so no enforcement point can disagree with it. Every
// read is scoped to the caller's workspace. Reads need a membership (viewer); every write needs admin, and writes an audit row with the value
// before and after.

import { randomUUID } from "node:crypto";
import { assertRole, isRole, type Role } from "../access.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { BudgetLedgerService, toUsd } from "../security/budget-ledger.ts";
import { monthlyVideoBudgetUsd, saveWorkspaceVideoBudget } from "../settings/video-budget.ts";
import { budgets } from "../../../engine/config/budgets.ts";
import { DECISION_CAP_RANGE, MEASURE_CEILING_RANGE, readOrchestratorPolicy, writeOrchestratorPolicy } from "../../../engine/orchestrator/policy-store.ts";
import { centsOf, factoryCapsProblem, LIMIT_SPECS, parseLimitValue, type LimitKind } from "./limits.ts";

/** One brand's limits and what it has committed so far, as the page shows them. Null is unset, never zero. */
export type BillingBrand = {
  brandId: string;
  name: string;
  brandBudgetUsd: number | null;
  committedUsd: number;
  factoryDailyCapUsd: number | null;
  factoryTotalCapUsd: number | null;
};

export type BillingPage = {
  organizationId: string;
  canEdit: boolean;
  workspace: {
    monthlyBudgetUsd: number | null;
    measureCeilingUsdPerSecond: number | null;
    decisionCapUsd: number | null;
    /** False when the stored orchestrator policy cannot be read. The two caps are then unknown, and shown as such. */
    policyReadable: boolean;
    policyReason: string | null;
  };
  brands: BillingBrand[];
  /** The engine's fixed cost of one master, in USD. Read-only: an estimate, not a limit. */
  fixedCostPerMasterUsd: number;
  ranges: Record<"measure" | "decision", { min: number; max: number }>;
};

/** The role of the caller in the workspace. A non-member is refused with the same words every workspace check uses. */
async function roleOf(sql: Sql, userId: string, organizationId: string): Promise<Role> {
  const rows = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = rows[0]?.role;
  if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
  return role;
}

async function requireRole(sql: Sql, userId: string, organizationId: string, minimum: Role): Promise<Role> {
  const role = await roleOf(sql, userId, organizationId);
  assertRole(role, minimum);
  return role;
}

/** The brand, when it belongs to the workspace and is not deleted. Any other brand is refused, so a limit is never written to another tenant. */
async function requireBrand(sql: Sql, organizationId: string, brandId: string): Promise<string> {
  const rows = await sql<{ id: string }>`
    select id from brands where id = ${brandId} and organization_id = ${organizationId} and deleted_at is null limit 1
  `;
  if (!rows[0]) throw new Error("That brand is not available to you.");
  return rows[0].id;
}

/** The page: the workspace's limits, and each brand's limits with what it has committed. Any member may read it. */
export async function readBillingPage(sql: Sql, input: { userId: string; organizationId: string }): Promise<BillingPage> {
  const role = await requireRole(sql, input.userId, input.organizationId, "viewer");
  const organizationId = input.organizationId;
  const monthlyVideoBudget = await monthlyVideoBudgetUsd(sql, organizationId);
  const policy = await readOrchestratorPolicy(sql, organizationId);

  const brandRows = await sql<{
    brand_id: string;
    name: string;
    max_spend_micros: string | null;
    spent_micros: string | null;
    reserved_micros: string | null;
    daily_cents: number | null;
    total_cents: number | null;
  }>`
    select b.id as brand_id, b.name,
      a.max_spend_micros::text as max_spend_micros, a.spent_micros::text as spent_micros, a.reserved_micros::text as reserved_micros,
      c.daily_cents, c.total_cents
    from brands b
    left join budget_accounts a on a.organization_id = b.organization_id and a.brand_id = b.id
    left join factory_spend_caps c on c.organization_id = b.organization_id and c.brand_id = b.id
    where b.organization_id = ${organizationId} and b.deleted_at is null
    order by b.name, b.id
  `;

  const brands: BillingBrand[] = brandRows.map((row) => {
    const max = row.max_spend_micros === null ? null : Number(row.max_spend_micros) / 1_000_000;
    const committed = row.spent_micros === null ? 0 : toUsd(BigInt(row.spent_micros) + BigInt(row.reserved_micros ?? "0"));
    const daily = row.daily_cents === null ? null : Number(row.daily_cents) / 100;
    const total = row.total_cents === null ? null : Number(row.total_cents) / 100;
    return {
      brandId: row.brand_id,
      name: row.name,
      brandBudgetUsd: max,
      committedUsd: committed,
      factoryDailyCapUsd: daily !== null && daily > 0 ? daily : null,
      factoryTotalCapUsd: total !== null && total > 0 ? total : null,
    };
  });

  const fixedCostPerMasterUsd = Object.values(budgets.fixedPerMasterUsd).reduce((sum, value) => sum + value, 0);
  return {
    organizationId,
    canEdit: role === "admin" || role === "owner",
    workspace: {
      monthlyBudgetUsd: monthlyVideoBudget,
      measureCeilingUsdPerSecond: policy.status === "ok" ? policy.policy.measureCeilingUsdPerSecond : null,
      decisionCapUsd: policy.status === "ok" ? policy.policy.decisionMaxUsdPerCall : null,
      policyReadable: policy.status === "ok",
      policyReason: policy.status === "unreadable" ? policy.reason : null,
    },
    brands,
    fixedCostPerMasterUsd: Math.round(fixedCostPerMasterUsd * 100) / 100,
    ranges: {
      measure: { min: MEASURE_CEILING_RANGE.min, max: MEASURE_CEILING_RANGE.max },
      decision: { min: DECISION_CAP_RANGE.min, max: DECISION_CAP_RANGE.max },
    },
  };
}

/** The audit row for one change: who, which limit, the value before and after. */
async function auditLimit(
  sql: Sql,
  input: { organizationId: string; userId: string; kind: LimitKind; objectType: "organization" | "brand"; objectId: string; before: unknown; after: unknown },
): Promise<void> {
  await sql`
    insert into audit_log (id, organization_id, actor_id, action, object_type, object_id, metadata)
    values (
      ${randomUUID()}, ${input.organizationId}, ${input.userId}, ${`billing.${input.kind}.updated`}, ${input.objectType}, ${input.objectId},
      ${JSON.stringify({ before: input.before, after: input.after })}
    )
  `;
}

/**
 * Saves one limit, or clears it (blank: unset, which refuses the step it guards). Admin only. The value is parsed by the rules of
 * limits.ts, written to the store that enforces it, and audited. A value the store refuses is an error and nothing is written.
 */
export async function saveBillingLimit(
  sql: Sql,
  input: { userId: string; organizationId: string; kind: LimitKind; brandId?: string | null; value: unknown },
): Promise<{ kind: LimitKind; brandId: string | null; value: number | null }> {
  await requireRole(sql, input.userId, input.organizationId, "admin");
  const spec = LIMIT_SPECS[input.kind];
  const parsed = parseLimitValue(input.kind, input.value);
  if (!parsed.ok) throw new Error(parsed.message);
  const value = parsed.value;
  const brandId = spec.scope === "brand" ? await requireBrand(sql, input.organizationId, input.brandId ?? "") : null;
  const objectType = brandId ? "brand" : "organization";
  const objectId = brandId ?? input.organizationId;

  // The limit and its audit row are one transaction: a limit is never live without its record, and two admins saving at once take turns.
  return withTransaction(sql, async (tx) => {
    // Saves in one workspace take turns. The decision cap and the measure ceiling share one stored policy that is read, changed and written
    // whole, so without this two admins saving at the same moment could write back each other's old value.
    const workspace = await tx<{ id: string }>`select id from organizations where id = ${input.organizationId} for update`;
    if (!workspace[0]) throw new Error("That workspace is not available to you.");
    switch (input.kind) {
      case "workspace_monthly_budget": {
        // The monthly budget keeps its own writer and its own audit row (video_budget.updated), so the engine and the text path read one figure.
        const before = await monthlyVideoBudgetUsd(tx, input.organizationId);
        await saveWorkspaceVideoBudget(tx, { userId: input.userId, organizationId: input.organizationId, value: value === null ? null : value });
        await auditLimit(tx, { ...input, objectType, objectId, before, after: value });
        return { kind: input.kind, brandId, value };
      }
      case "measure_ceiling":
      case "decision_cap": {
        const read = await readOrchestratorPolicy(tx, input.organizationId);
        const before = read.status === "ok" ? (input.kind === "measure_ceiling" ? read.policy.measureCeilingUsdPerSecond : read.policy.decisionMaxUsdPerCall) : null;
        const patch = input.kind === "measure_ceiling" ? { measureCeilingUsdPerSecond: value } : { decisionMaxUsdPerCall: value };
        await writeOrchestratorPolicy(tx, { organizationId: input.organizationId, actorId: input.userId, patch });
        await auditLimit(tx, { ...input, objectType, objectId, before, after: value });
        return { kind: input.kind, brandId, value };
      }
      case "brand_budget": {
        if (value === null || brandId === null) throw new Error("Enter the brand budget in US dollars. Enter 0 to stop all paid work for this brand.");
        const before = (await BudgetLedgerService.getAccount(tx, input.organizationId, brandId))?.maxSpendMicros;
        await BudgetLedgerService.setBrandBudget(tx, { organizationId: input.organizationId, brandId, capUsd: value });
        await auditLimit(tx, { ...input, objectType, objectId, before: before === undefined ? null : toUsd(before), after: value });
        return { kind: input.kind, brandId, value };
      }
      case "factory_daily_cap":
      case "factory_total_cap": {
        if (brandId === null) throw new Error("A factory cap belongs to one brand.");
        const rows = await tx<{ daily_cents: number; total_cents: number }>`
          select daily_cents, total_cents from factory_spend_caps
          where organization_id = ${input.organizationId} and brand_id = ${brandId} limit 1 for update
        `;
        const currentDaily = rows[0] && rows[0].daily_cents > 0 ? rows[0].daily_cents / 100 : null;
        const currentTotal = rows[0] && rows[0].total_cents > 0 ? rows[0].total_cents / 100 : null;
        const daily = input.kind === "factory_daily_cap" ? value : currentDaily;
        const total = input.kind === "factory_total_cap" ? value : currentTotal;
        const problem = factoryCapsProblem(daily, total);
        if (problem) throw new Error(problem);
        const before = input.kind === "factory_daily_cap" ? currentDaily : currentTotal;
        // Unset is stored as zero, which the factory reads as no cap and refuses on.
        await tx`
          insert into factory_spend_caps (organization_id, brand_id, daily_cents, total_cents, updated_by)
          values (${input.organizationId}, ${brandId}, ${centsOf(daily) ?? 0}, ${centsOf(total) ?? 0}, ${input.userId})
          on conflict (organization_id, brand_id) do update
            set daily_cents = excluded.daily_cents, total_cents = excluded.total_cents, updated_by = excluded.updated_by, updated_at = now()
        `;
        await auditLimit(tx, { ...input, objectType, objectId, before, after: value });
        return { kind: input.kind, brandId, value };
      }
    }
  });
}
