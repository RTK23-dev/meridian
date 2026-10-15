import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { requireBrand } from "../brand-membership.ts";
import { parseNewThemePage, parseThemePageFields } from "./model.ts";
import { archiveThemePage, createThemePage, listThemePages, updateThemePage } from "./store.ts";

function clip(value: unknown, max = 120): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The pages of a brand that are not archived. Any member who can see the brand can read them. */
export const listThemePagesAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = clip(objectOf(input).brandId);
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "viewer");
    return listThemePages(sql, { organizationId: access.organizationId, brandId: data.brandId });
  });

/** Creates a page. A member or above may create one. The fields are checked by the same rules whether or not a link is given. */
export const createThemePageAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectOf(input);
    const brandId = clip(body.brandId);
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId, page: body.page };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const parsed = parseNewThemePage(data.page);
    if (!parsed.ok) throw new Error(parsed.error);
    const id = await createThemePage(sql, { organizationId: access.organizationId, brandId: data.brandId }, parsed.value, context.userId);
    return { id };
  });

/** Updates a page with the fields that changed. A member or above may update one. */
export const updateThemePageAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectOf(input);
    const brandId = clip(body.brandId);
    const pageId = clip(body.pageId, 64);
    if (!brandId || !pageId) throw new Error("Choose a brand and a page.");
    return { brandId, pageId, page: body.page };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const parsed = parseThemePageFields(data.page);
    if (!parsed.ok) throw new Error(parsed.error);
    await updateThemePage(sql, { organizationId: access.organizationId, brandId: data.brandId }, data.pageId, parsed.value, context.userId);
    return { ok: true as const };
  });

/** Archives a page. Retiring a page is an admin decision, so it needs the admin role. */
export const archiveThemePageAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectOf(input);
    const brandId = clip(body.brandId);
    const pageId = clip(body.pageId, 64);
    if (!brandId || !pageId) throw new Error("Choose a brand and a page.");
    return { brandId, pageId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "admin");
    await archiveThemePage(sql, { organizationId: access.organizationId, brandId: data.brandId }, data.pageId, context.userId);
    return { ok: true as const };
  });
