// The cookbook server functions (round 3, K7). Each one checks the brand's membership (requireBrand) with the minimum role it needs, then
// hands the work to the service, which checks the cookbook-level rules. Reads need a viewer; writes need a member; the service decides who
// may edit or archive what.

import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { requireBrand } from "../brand-membership.ts";
import { archiveCookbookFor, forkCookbookFor, libraryFor, proposeFor, readCookbookFor, resolveFor, saveCookbookFor } from "./service.ts";
import { chooseCookbookFor } from "../content-factory/cookbook-choice.ts";

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

/**
 * The cookbooks proposed for a run (K10/K18). Read-only, so a viewer may ask. The selector's model port is not connected in this build, so the
 * answer is the picker over the eligible cookbooks, never a guessed pick, until the owner approves the role (Q34).
 */
export const proposeCookbookAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectOf(input);
    const brandId = clip(body.brandId);
    if (!brandId) throw new Error("Choose a brand.");
    const lengthMs = typeof body.lengthMs === "number" && body.lengthMs > 0 && body.lengthMs <= 180000 ? body.lengthMs : NaN;
    if (!Number.isFinite(lengthMs)) throw new Error("Choose a length between 1 and 180 seconds.");
    const uploads = objectOf(body.uploads);
    const budget = typeof body.budgetUsd === "number" && body.budgetUsd > 0 ? body.budgetUsd : null;
    const briefChars = typeof body.briefChars === "number" && body.briefChars >= 0 && body.briefChars <= 8000 ? body.briefChars : 0;
    return {
      brandId,
      lengthMs,
      inputs: {
        briefChars,
        reference: { attached: objectOf(body.reference).attached === true, dnaCached: objectOf(body.reference).dnaCached === true },
        productKit: body.productKit === true,
        uploads: { voice: uploads.voice === true, footage: uploads.footage === true, music: uploads.music === true },
        budgetUsd: budget,
        runKind: body.runKind === "automated_loop" ? ("automated_loop" as const) : ("normal" as const),
      },
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "viewer");
    return proposeFor(sql, { organizationId: access.organizationId, brandId: data.brandId, inputs: data.inputs, lengthMs: data.lengthMs, port: null });
  });

/**
 * Records the person's choice of cookbook for a draft run (K18a). The session's own access rule applies (an admin, as for starting a run), and a
 * started run keeps its record. The selector's port is not connected in this build, so the choice is made from the eligible list.
 */
export const chooseCookbookForRunAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectOf(input);
    const sessionId = clip(body.sessionId, 80);
    const cookbookId = clip(body.cookbookId, 80);
    const version = typeof body.version === "number" && Number.isInteger(body.version) && body.version >= 1 ? body.version : NaN;
    if (!sessionId || !cookbookId || !Number.isFinite(version)) throw new Error("Choose a run, a cookbook and its version.");
    const values = objectOf(body.values);
    const cleaned: Record<string, string | number | boolean> = {};
    for (const [id, value] of Object.entries(values)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") cleaned[id.slice(0, 80)] = value;
    }
    return { sessionId, choice: { cookbookId, version, values: cleaned } };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return chooseCookbookFor(sql, { userId: context.userId, sessionId: data.sessionId, choice: data.choice, port: null });
  });
