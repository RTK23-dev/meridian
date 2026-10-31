// The cookbook server functions (round 3, K7). Each one checks the brand's membership (requireBrand) with the minimum role it needs, then
// hands the work to the service, which checks the cookbook-level rules. Reads need a viewer; writes need a member; the service decides who
// may edit or archive what.

import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { requireBrand } from "../brand-membership.ts";
import { archiveCookbookFor, forkCookbookFor, libraryFor, readCookbookFor, resolveFor, saveCookbookFor } from "./service.ts";

function clip(value: unknown, max = 120): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function versionOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1_000_000 ? value : undefined;
}

/** The library of a brand: the built-in cookbooks and the workspace cookbooks visible to it. */
export const listCookbooksAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = clip(objectOf(input).brandId);
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId, includeArchived: objectOf(input).includeArchived === true };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "viewer");
    return libraryFor(sql, { organizationId: access.organizationId, brandId: data.brandId, includeArchived: data.includeArchived });
  });

/** One cookbook: a built-in, or a visible workspace version. */
export const readCookbookAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectOf(input);
    const brandId = clip(body.brandId);
    const cookbookId = clip(body.cookbookId, 80);
    if (!brandId || !cookbookId) throw new Error("Choose a brand and a cookbook.");
    return { brandId, cookbookId, version: versionOf(body.version) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "viewer");
    return readCookbookFor(sql, { organizationId: access.organizationId, brandId: data.brandId, cookbookId: data.cookbookId, version: data.version });
  });

/** Saves a new version of a workspace cookbook. Members create; the creator or an admin edits. */
export const saveCookbookAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectOf(input);
    const brandId = clip(body.brandId);
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId, cookbook: body.cookbook };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    return saveCookbookFor(sql, { organizationId: access.organizationId, brandId: data.brandId, role: access.role, userId: context.userId, cookbook: data.cookbook });
  });

/** Forks a built-in or a visible workspace cookbook into a new id. */
export const forkCookbookAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectOf(input);
    const brandId = clip(body.brandId);
    const cookbookId = clip(body.cookbookId, 80);
    const newCookbookId = clip(body.newCookbookId, 80);
    if (!brandId || !cookbookId || !newCookbookId) throw new Error("Choose a brand, a cookbook to fork and a new id.");
    return { brandId, cookbookId, version: versionOf(body.version), newCookbookId, shareWithWorkspace: body.shareWithWorkspace === true };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    return forkCookbookFor(sql, {
      organizationId: access.organizationId,
      brandId: data.brandId,
      role: access.role,
      userId: context.userId,
      from: { cookbookId: data.cookbookId, version: data.version },
      newCookbookId: data.newCookbookId,
      shareWithWorkspace: data.shareWithWorkspace,
    });
  });

/** Archives a workspace cookbook: its creator or an admin. */
export const archiveCookbookAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectOf(input);
    const brandId = clip(body.brandId);
    const cookbookId = clip(body.cookbookId, 80);
    if (!brandId || !cookbookId) throw new Error("Choose a brand and a cookbook.");
    return { brandId, cookbookId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    return archiveCookbookFor(sql, { organizationId: access.organizationId, brandId: data.brandId, role: access.role, userId: context.userId, cookbookId: data.cookbookId });
  });

/** Resolves a cookbook with the person's values. Writes nothing, so a viewer may run it. */
export const resolveCookbookAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectOf(input);
    const brandId = clip(body.brandId);
    const cookbookId = clip(body.cookbookId, 80);
    const lengthMs = typeof body.lengthMs === "number" ? body.lengthMs : NaN;
    if (!brandId || !cookbookId) throw new Error("Choose a brand and a cookbook.");
    const values = objectOf(body.values);
    const voiceCharacters = typeof body.voiceCharacters === "number" ? body.voiceCharacters : undefined;
    return { brandId, cookbookId, version: versionOf(body.version), lengthMs, values: values as Record<string, string | number | boolean>, voiceCharacters };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "viewer");
    return resolveFor(sql, {
      organizationId: access.organizationId,
      brandId: data.brandId,
      cookbookId: data.cookbookId,
      version: data.version,
      values: data.values,
      lengthMs: data.lengthMs,
      voiceCharacters: data.voiceCharacters,
    });
  });
