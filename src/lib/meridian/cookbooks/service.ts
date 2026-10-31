// The cookbook service (round 3, K7): what the server functions do, with the role and the brand already checked by the caller. Built-in
// cookbooks come from code, workspace cookbooks from the store, and every write asks the policy first. Kept apart from the server functions so
// that each rule can be tested on PGlite.

import type { Role } from "../access.ts";
import type { Sql } from "../learning/store.ts";
import { builtinCookbook, builtinCookbooks, isBuiltinId } from "./builtin/index.ts";
import { canCreate, canEdit, canShareWithWorkspace } from "./policy.ts";
import { resolveCookbook, type ResolvedCookbook, type ResolveOptions } from "./resolve.ts";
import { archiveCookbook, forkCookbook, getCookbookVersion, listCookbooks, saveCookbookVersion, type StoredCookbook, type StoreResult } from "./store.ts";
import type { Cookbook } from "./schema.ts";

export type CookbookSource = { source: "builtin"; cookbook: Cookbook } | { source: "workspace"; cookbook: Cookbook; stored: StoredCookbook };

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; reason: string; issues?: string[] };

function fromStore<T>(result: StoreResult<T>): ServiceResult<T> {
  if (result.ok) return { ok: true, value: result.value };
  const reasons: Record<string, string> = {
    invalid: "That cookbook is not valid.",
    reserved: "That id belongs to a built-in cookbook.",
    conflict: "Another edit wrote this version first. Reload and try again.",
    not_found: "No such cookbook is visible to this brand.",
    brand_mismatch: "A cookbook keeps its brand. Fork it to share it elsewhere.",
  };
  return { ok: false, reason: reasons[result.reason] ?? result.reason, ...(result.issues ? { issues: result.issues } : {}) };
}

/** The library of a brand: every built-in cookbook, and the workspace cookbooks visible to the brand (latest version of each). */
export async function libraryFor(sql: Sql, input: { organizationId: string; brandId: string; includeArchived?: boolean }) {
  const workspace = await listCookbooks(sql, input);
  return { builtins: builtinCookbooks(), workspace };
}

/** One cookbook by id: a built-in, or the visible workspace version (the latest unless a version is named). */
export async function readCookbookFor(
  sql: Sql,
  input: { organizationId: string; brandId: string; cookbookId: string; version?: number },
): Promise<ServiceResult<CookbookSource>> {
  const builtin = builtinCookbook(input.cookbookId, input.version);
  if (builtin !== undefined) return { ok: true, value: { source: "builtin", cookbook: builtin } };
  const stored = await getCookbookVersion(sql, input);
  if (!stored.ok) return fromStore(stored);
  return { ok: true, value: { source: "workspace", cookbook: stored.value.cookbook, stored: stored.value } };
}

/**
 * Saves a new version of a workspace cookbook. A new id needs the member role. An existing one needs the edit rule (its creator, or an admin;
 * a copy of a built-in is the admin's). A built-in id is reserved.
 */
export async function saveCookbookFor(
  sql: Sql,
  input: { organizationId: string; brandId: string; role: Role; userId: string; cookbook: unknown },
): Promise<ServiceResult<StoredCookbook>> {
  const id = typeof (input.cookbook as { cookbookId?: unknown })?.cookbookId === "string" ? (input.cookbook as { cookbookId: string }).cookbookId : "";
  if (id !== "" && isBuiltinId(id)) return { ok: false, reason: "That id belongs to a built-in cookbook." };
  if (id !== "") {
    const existing = await getCookbookVersion(sql, { organizationId: input.organizationId, brandId: input.brandId, cookbookId: id });
    if (existing.ok) {
      if (!canEdit(input.role, input.userId, existing.value)) return { ok: false, reason: "You can edit only the cookbooks you made." };
    } else if (!canCreate(input.role)) {
      return { ok: false, reason: "Only members and above can create a cookbook." };
    }
  } else if (!canCreate(input.role)) {
    return { ok: false, reason: "Only members and above can create a cookbook." };
  }
  return fromStore(
    await saveCookbookVersion(sql, { organizationId: input.organizationId, brandId: input.brandId, cookbook: input.cookbook, createdBy: input.userId }),
  );
}

/**
 * Forks a built-in or a visible workspace cookbook into a new id. Sharing with the workspace is the creator's choice, and members may choose it.
 * The parent is recorded either way.
 */
export async function forkCookbookFor(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    role: Role;
    userId: string;
    from: { cookbookId: string; version?: number };
    newCookbookId: string;
    shareWithWorkspace: boolean;
  },
): Promise<ServiceResult<StoredCookbook>> {
  if (!canCreate(input.role)) return { ok: false, reason: "Only members and above can fork a cookbook." };
  if (input.shareWithWorkspace && !canShareWithWorkspace(input.role)) return { ok: false, reason: "You cannot share a cookbook with the workspace." };
  if (isBuiltinId(input.newCookbookId)) return { ok: false, reason: "That id belongs to a built-in cookbook." };

  const source = await readCookbookFor(sql, { organizationId: input.organizationId, brandId: input.brandId, cookbookId: input.from.cookbookId, version: input.from.version });
  if (!source.ok) return source;
  if (source.value.source === "workspace") {
    return fromStore(
      await forkCookbook(sql, {
        organizationId: input.organizationId,
        brandId: input.brandId,
        from: { cookbookId: input.from.cookbookId, version: source.value.stored.version },
        newCookbookId: input.newCookbookId,
        shareWithWorkspace: input.shareWithWorkspace,
        createdBy: input.userId,
      }),
    );
  }
  // A built-in: a copy with the built-in as its parent. Its body is checked by the store like any save.
  const copy = { ...source.value.cookbook, cookbookId: input.newCookbookId, version: 1, scope: "workspace" as const, parent: undefined };
  return fromStore(
    await saveCookbookVersion(sql, {
      organizationId: input.organizationId,
      brandId: input.shareWithWorkspace ? null : input.brandId,
      cookbook: copy,
      createdBy: input.userId,
      parent: { cookbookId: source.value.cookbook.cookbookId, version: source.value.cookbook.version },
    }),
  );
}

/** Archives a workspace cookbook: its creator, or an admin. A built-in cannot be archived. */
export async function archiveCookbookFor(
  sql: Sql,
  input: { organizationId: string; brandId: string; role: Role; userId: string; cookbookId: string },
): Promise<ServiceResult<{ archivedVersions: number }>> {
  if (isBuiltinId(input.cookbookId)) return { ok: false, reason: "A built-in cookbook cannot be archived." };
  const latest = await getCookbookVersion(sql, { organizationId: input.organizationId, brandId: input.brandId, cookbookId: input.cookbookId });
  if (!latest.ok) return fromStore(latest);
  if (!canEdit(input.role, input.userId, latest.value)) return { ok: false, reason: "You can archive only the cookbooks you made." };
  return fromStore(await archiveCookbook(sql, { organizationId: input.organizationId, brandId: input.brandId, cookbookId: input.cookbookId }));
}

/**
 * Resolves a cookbook with the person's values: no write, so the viewer role is enough. The component declarations are not supplied here, so a
 * cookbook whose controls bind a component variable is refused until the declarations are wired (K21).
 */
export async function resolveFor(
  sql: Sql,
  input: { organizationId: string; brandId: string; cookbookId: string; version?: number } & Omit<ResolveOptions, "context">,
): Promise<ServiceResult<ResolvedCookbook>> {
  const source = await readCookbookFor(sql, input);
  if (!source.ok) return source;
  const result = resolveCookbook(source.value.cookbook, { values: input.values, lengthMs: input.lengthMs, voiceCharacters: input.voiceCharacters });
  if (!result.ok) return { ok: false, reason: "This cookbook cannot be resolved with these values.", issues: result.issues };
  return { ok: true, value: result.resolved };
}
