import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { listDiscoveredItemsFor } from "./item-list.ts";
import { itemProvenanceFor } from "./provenance-view.ts";

/** The pages and posts stored for one brand. Anyone who can view the brand may read them. */
export const listDiscoveredItems = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = input && typeof input === "object" && typeof (input as { brandId?: unknown }).brandId === "string"
      ? (input as { brandId: string }).brandId.trim().slice(0, 80)
      : "";
    if (!brandId) throw new Error("brandId is required.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => listDiscoveredItemsFor(await getSql(), context.userId, data.brandId));

/** The runs that observed one stored page, for a member of its brand (read-only). Another brand's page reports no record. */
export const getDiscoveredItemProvenance = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = typeof value.brandId === "string" ? value.brandId.trim().slice(0, 80) : "";
    const itemId = typeof value.itemId === "string" ? value.itemId.trim().slice(0, 80) : "";
    if (!brandId) throw new Error("brandId is required.");
    if (!itemId) throw new Error("itemId is required.");
    return { brandId, itemId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => itemProvenanceFor(await getSql(), context.userId, data.brandId, data.itemId));
