import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole } from "@/lib/meridian/access";
import { loadBrandContext } from "@/lib/meridian/context/load";
import { rankOpportunities } from "@/lib/meridian/opportunity/engine";

function clip(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

/** Same ranker as refresh and the studio session. Not a second scoring path. */
export const getStudioBoard = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = clip((input as { brandId?: unknown })?.brandId);
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const brands = await sql<{ organization_id: string }>`
      select organization_id from brands where id = ${data.brandId} and deleted_at is null limit 1
    `;
    const organizationId = brands[0]?.organization_id ?? "";
    if (!organizationId) throw new Error("Brand not found.");
    const members = await sql<{ role: string }>`
      select role from memberships where user_id = ${context.userId} and organization_id = ${organizationId} limit 1
    `;
    const role = members[0]?.role;
    if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
    assertRole(role, "viewer");
    const loaded = await loadBrandContext(sql, organizationId, data.brandId);
    const ranked = rankOpportunities({ organizationId, brandId: data.brandId, ...loaded });
    return {
      observationCount: loaded.creatives.length,
      discovered: ranked.filter((item) => item.source === "discovered").slice(0, 4).map((item) => ({
        id: item.hypothesisId,
        label: item.label,
        angle: item.angle,
        score: item.expectedValue,
        reason: item.reason,
      })),
      exploration: ranked.find((item) => item.source === "prior")
        ? { label: ranked.find((item) => item.source === "prior")?.label }
        : null,
    };
  });
