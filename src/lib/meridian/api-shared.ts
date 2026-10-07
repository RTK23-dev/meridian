import { type Sql } from "@/lib/db";
import { assertRole, isRole, type Role } from "@/lib/meridian/access";
import {
  BRAIN_FIELDS,
  emptyBrain,
  isAutomationLevel,
  isProvenance,
  type BrainValues,
  type ProvenanceMap,
} from "@/lib/meridian/brain";
import { type ScoreWeights } from "@/lib/meridian/scoring";

export type Membership = { organizationId: string; role: Role };

export function id(): string {
  return crypto.randomUUID();
}

export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function asCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

export function asRecord(value: unknown): Record<string, string> {
  let source: unknown = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

export function clip(value: unknown, max: number, label: string, required = false): string {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return "";
    throw new Error(`${label} must be text.`);
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${label} is required.`);
  if (trimmed.length > max) throw new Error(`${label} is too long.`);
  return trimmed;
}

export function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid request.");
  }
  return input as Record<string, unknown>;
}

export async function membership(
  sql: Sql,
  userId: string,
  organizationId: string,
): Promise<Membership | null> {
  const rows = await sql<{ role: string }>`
    select role from memberships
    where user_id = ${userId} and organization_id = ${organizationId}
    limit 1
  `;
  const role = rows[0]?.role;
  if (!role || !isRole(role)) return null;
  return { organizationId, role };
}

export async function requireMembership(
  sql: Sql,
  userId: string,
  organizationId: string,
  minimum: Role,
): Promise<Membership> {
  const row = await membership(sql, userId, organizationId);
  if (!row) throw new Error("That workspace is not available to you.");
  assertRole(row.role, minimum);
  return row;
}

export async function brandOrg(
  sql: Sql,
  brandId: string,
): Promise<{ organizationId: string } | null> {
  const rows = await sql<{ organization_id: string }>`
    select organization_id from brands
    where id = ${brandId} and deleted_at is null
    limit 1
  `;
  const organizationId = rows[0]?.organization_id;
  return organizationId ? { organizationId } : null;
}

export async function writeAudit(
  sql: Sql,
  entry: {
    organizationId: string;
    brandId?: string | null;
    actorId: string;
    action: string;
    objectType: string;
    objectId: string;
    metadata?: Record<string, string>;
  },
): Promise<void> {
  await sql`
    insert into audit_log (
      id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata
    ) values (
      ${id()},
      ${entry.organizationId},
      ${entry.brandId ?? null},
      ${entry.actorId},
      ${entry.action},
      ${entry.objectType},
      ${entry.objectId},
      ${JSON.stringify(entry.metadata ?? {})}
    )
  `;
}

export function brainFromRow(row: Record<string, unknown> | undefined): {
  brain: BrainValues;
  provenance: ProvenanceMap;
  version: number;
} {
  const brain = emptyBrain();
  const provenance: ProvenanceMap = {};
  if (!row) return { brain, provenance, version: 0 };
  for (const field of BRAIN_FIELDS) {
    brain[field.key] = asText(row[field.column]);
  }
  const level = asText(row.automation_level);
  brain.automationLevel = isAutomationLevel(level) ? level : "manual";
  const stored = asRecord(row.provenance);
  for (const field of BRAIN_FIELDS) {
    const value = stored[field.key];
    if (value && isProvenance(value)) provenance[field.key] = value;
  }
  const version = Number(row.version);
  return { brain, provenance, version: Number.isFinite(version) ? version : 1 };
}

export function weightsFromRow(row: Record<string, unknown>): ScoreWeights {
  return {
    brandFit: Number(row.brand_fit),
    historicalEvidence: Number(row.historical_evidence),
    marketSignal: Number(row.market_signal),
    novelty: Number(row.novelty),
    reproducibility: Number(row.reproducibility),
    saturation: Number(row.saturation),
    risk: Number(row.risk),
  };
}

export const BRAIN_COLUMNS = BRAIN_FIELDS.map((field) => `br.${field.column}`).join(", ");
