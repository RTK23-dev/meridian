import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { listDiscoveredItemsFor } from "./item-list.ts";

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
