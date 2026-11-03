// Custom cookbooks in the database (round 3, K6). One row per version; rows are immutable. An edit writes the next version, a fork writes a
// new cookbook id whose parent is recorded, and archiving hides a cookbook from the library while old runs can still read it. A cookbook
// with a brand is visible to that brand; a cookbook with no brand is shared with the whole workspace (decision D3).
//
// Every body is validated on the way in, and again on the way out: a stored body that no longer matches its contract is an internal error,
// never silently used. Built-in cookbook ids are reserved, so a workspace cannot save over one.

import { randomUUID } from "node:crypto";
import { contentHash } from "../../../engine/contracts/hash.ts";
import type { Sql } from "../learning/store.ts";
import { validateCookbook, type ValidationContext } from "./validate.ts";
import { isBuiltinId } from "./builtin/index.ts";
import type { Cookbook } from "./schema.ts";

/** Ids that belong to built-in cookbooks. A workspace cookbook cannot use them. */
const RESERVED_PREFIXES = ["ck_factory_", "ck_blank_", "ck_3d_"];

export type StoredCookbook = {
  rowId: string;
  organizationId: string;
  brandId: string | null;
  cookbookId: string;
  version: number;
  parent: { cookbookId: string; version: number } | null;
  cookbook: Cookbook;
  contentHash: string;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
};

export type StoreResult<T> = { ok: true; value: T } | { ok: false; reason: "invalid" | "reserved" | "conflict" | "not_found" | "brand_mismatch"; issues?: string[] };

type Row = {
  id: string;
  organization_id: string;
  brand_id: string | null;
  cookbook_id: string;
  version: number | string;
  parent_cookbook_id: string | null;
  parent_version: number | string | null;
  body: unknown;
  content_hash: string;
  created_by: string;
  created_at: Date | string;
  archived_at: Date | string | null;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromRow(row: Row, context: ValidationContext = {}): StoredCookbook {
  const raw = typeof row.body === "string" ? JSON.parse(row.body) : row.body;
  const checked = validateCookbook(raw, context);
  if (!checked.ok) {
    throw new Error(`the stored cookbook ${row.cookbook_id} version ${row.version} no longer matches its contract: ${checked.issues[0] ?? ""}`);
  }
  const parent =
    row.parent_cookbook_id === null || row.parent_version === null
      ? null
      : { cookbookId: row.parent_cookbook_id, version: Number(row.parent_version) };
  return {
    rowId: row.id,
    organizationId: row.organization_id,
    brandId: row.brand_id,
    cookbookId: row.cookbook_id,
    version: Number(row.version),
    parent,
    cookbook: checked.cookbook,
    contentHash: row.content_hash,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    archivedAt: row.archived_at === null ? null : toIso(row.archived_at),
  };
}

function isReserved(cookbookId: string): boolean {
  return isBuiltinId(cookbookId) || RESERVED_PREFIXES.some((prefix) => cookbookId.startsWith(prefix));
}

/**
 * Writes the next version of a cookbook. A new cookbook gets version 1. An existing one must have the same brand (or workspace) scope, and
 * the version is the next number, so two edits never share one. The body is validated first; a body that fails is refused with its issues.
 */
export async function saveCookbookVersion(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string | null;
    cookbook: unknown;
    createdBy: string;
    parent?: { cookbookId: string; version: number } | null;
    context?: ValidationContext;
  },
): Promise<StoreResult<StoredCookbook>> {
  const checked = validateCookbook(input.cookbook, input.context);
  if (!checked.ok) return { ok: false, reason: "invalid", issues: checked.issues };
  const cookbook = checked.cookbook;
  if (cookbook.scope !== "workspace") return { ok: false, reason: "invalid", issues: ["scope: a saved cookbook is a workspace cookbook"] };
  if (isReserved(cookbook.cookbookId)) return { ok: false, reason: "reserved", issues: [`${cookbook.cookbookId} is a built-in id`] };

  // Only what the saver can see is looked at: an id another brand uses is not consulted, so a brand never learns that another brand's
  // cookbook exists. A cookbook id is unique per brand (and for the workspace-shared ones), not across the whole workspace.
  if (input.brandId !== null) {
    const shared = await sql<{ id: string }>`
      select id from cookbooks where organization_id = ${input.organizationId} and cookbook_id = ${cookbook.cookbookId} and brand_id is null limit 1
    `;
    if (shared[0] !== undefined) {
      return { ok: false, reason: "brand_mismatch", issues: ["a cookbook keeps its brand: fork it to share it elsewhere"] };
    }
  }
  const existing = await sql<{ version: number | string; parent_cookbook_id: string | null; parent_version: number | string | null }>`
    select version, parent_cookbook_id, parent_version from cookbooks
    where organization_id = ${input.organizationId} and cookbook_id = ${cookbook.cookbookId} and brand_id is not distinct from ${input.brandId}
    order by version desc limit 1
  `;
  const latest = existing[0];
  const version = latest === undefined ? 1 : Number(latest.version) + 1;
  // A later version keeps the parent its earlier version recorded (a copy of a built-in stays a copy of it), unless the caller names one.
  const carried = latest?.parent_cookbook_id ? { cookbookId: latest.parent_cookbook_id, version: Number(latest.parent_version) } : null;
  const parent = input.parent !== undefined ? input.parent : carried;
  const body = { ...cookbook, version, scope: "workspace" as const, ...(parent ? { parent } : {}) };
  const hash = contentHash(body);
  const rowId = randomUUID();
  try {
    await sql`
      insert into cookbooks (id, organization_id, brand_id, cookbook_id, version, parent_cookbook_id, parent_version, body, content_hash, created_by)
      values (${rowId}, ${input.organizationId}, ${input.brandId}, ${cookbook.cookbookId}, ${version},
        ${parent?.cookbookId ?? null}, ${parent?.version ?? null}, ${JSON.stringify(body)}::jsonb, ${hash}, ${input.createdBy})
    `;
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: "conflict", issues: ["another edit wrote this version first: reload and try again"] };
    throw error;
  }
  return getCookbookVersion(sql, { organizationId: input.organizationId, brandId: input.brandId, cookbookId: cookbook.cookbookId, version, context: input.context });
}

/**
 * The latest visible version of a cookbook (or the named one). Visible: the brand's own, or shared with the workspace. A null brand sees only
 * the workspace-shared ones. Archived ones resolve too.
 */
export async function getCookbookVersion(
  sql: Sql,
  input: { organizationId: string; brandId: string | null; cookbookId: string; version?: number; context?: ValidationContext },
): Promise<StoreResult<StoredCookbook>> {
  const scope = await scopeOf(sql, input.organizationId, input.brandId, input.cookbookId);
  const rows =
    input.version === undefined
      ? await sql<Row>`
          select * from cookbooks
          where organization_id = ${input.organizationId} and cookbook_id = ${input.cookbookId} and brand_id is not distinct from ${scope}
          order by version desc limit 1
        `
      : await sql<Row>`
          select * from cookbooks
          where organization_id = ${input.organizationId} and cookbook_id = ${input.cookbookId} and version = ${input.version}
            and brand_id is not distinct from ${scope}
          limit 1
        `;
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: "not_found" };
  return { ok: true, value: fromRow(row, input.context) };
}

/** The library of a brand: the latest version of each cookbook visible to it. Archived cookbooks are left out unless asked for. */
export async function listCookbooks(
  sql: Sql,
  input: { organizationId: string; brandId: string | null; includeArchived?: boolean; context?: ValidationContext },
): Promise<StoredCookbook[]> {
  const rows = await sql<Row>`
    select distinct on (cookbook_id) * from cookbooks
    where organization_id = ${input.organizationId} and (brand_id is null or brand_id = ${input.brandId})
    order by cookbook_id, (brand_id is null), version desc
  `;
  return rows
    .map((row) => fromRow(row, input.context))
    .filter((cookbook) => input.includeArchived === true || cookbook.archivedAt === null)
    .sort((a, b) => a.cookbookId.localeCompare(b.cookbookId));
}

/** One version a brand can see: its number, when it was written, and whether the cookbook is archived. The author is not shown here. */
export type VersionSummary = { version: number; createdAt: string; archived: boolean };

/** The versions of a workspace cookbook that a brand can see, newest first. A version written for another brand is not listed. */
export async function listCookbookVersions(sql: Sql, input: { organizationId: string; brandId: string | null; cookbookId: string }): Promise<VersionSummary[]> {
  const scope = await scopeOf(sql, input.organizationId, input.brandId, input.cookbookId);
  const rows = await sql<{ version: number; created_at: unknown; archived_at: unknown }>`
    select version, created_at, archived_at from cookbooks
    where organization_id = ${input.organizationId} and cookbook_id = ${input.cookbookId} and brand_id is not distinct from ${scope}
    order by version desc
  `;
  return rows.map((row) => ({
    version: Number(row.version),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    archived: row.archived_at !== null && row.archived_at !== undefined,
  }));
}

/**
 * Forks a visible cookbook into a new cookbook id, with its parent recorded. shareWithWorkspace decides the scope (D3): a brand-only fork
 * stays with the brand, a shared fork is visible to the whole workspace.
 */
export async function forkCookbook(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    from: { cookbookId: string; version: number };
    newCookbookId: string;
    shareWithWorkspace: boolean;
    createdBy: string;
    context?: ValidationContext;
  },
): Promise<StoreResult<StoredCookbook>> {
  const source = await getCookbookVersion(sql, {
    organizationId: input.organizationId,
    brandId: input.brandId,
    cookbookId: input.from.cookbookId,
    version: input.from.version,
    context: input.context,
  });
  if (!source.ok) return source;
  const copy = { ...source.value.cookbook, cookbookId: input.newCookbookId, version: 1, scope: "workspace" as const };
  delete (copy as { parent?: unknown }).parent;
  return saveCookbookVersion(sql, {
    organizationId: input.organizationId,
    brandId: input.shareWithWorkspace ? null : input.brandId,
    cookbook: copy,
    createdBy: input.createdBy,
    parent: { cookbookId: input.from.cookbookId, version: input.from.version },
    context: input.context,
  });
}

/** Hides every version of a cookbook from the library. Old runs still resolve it. A cookbook outside the brand's view is not found. */
export async function archiveCookbook(
  sql: Sql,
  input: { organizationId: string; brandId: string | null; cookbookId: string },
): Promise<StoreResult<{ archivedVersions: number }>> {
  const scope = await scopeOf(sql, input.organizationId, input.brandId, input.cookbookId);
  const archived = await sql<{ id: string }>`
    update cookbooks set archived_at = now()
    where organization_id = ${input.organizationId} and cookbook_id = ${input.cookbookId} and archived_at is null
      and brand_id is not distinct from ${scope}
    returning id
  `;
  if (archived.length === 0) return { ok: false, reason: "not_found" };
  return { ok: true, value: { archivedVersions: archived.length } };
}

/**
 * Which copy of a cookbook id a brand means: its own when it has one, otherwise the workspace-shared one (null). A brand's own cookbook
 * shadows a shared one with the same id, and only that one copy is read, listed or archived.
 */
async function scopeOf(sql: Sql, organizationId: string, brandId: string | null, cookbookId: string): Promise<string | null> {
  if (brandId === null) return null;
  const own = await sql<{ id: string }>`
    select id from cookbooks where organization_id = ${organizationId} and cookbook_id = ${cookbookId} and brand_id = ${brandId} limit 1
  `;
  return own[0] !== undefined ? brandId : null;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "23505" || /unique/i.test(String((error as { message?: unknown }).message ?? ""));
}
