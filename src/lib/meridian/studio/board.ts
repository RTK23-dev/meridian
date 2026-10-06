import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole } from "@/lib/meridian/access";
import { loadBrandContext } from "@/lib/meridian/context/load";
import { fingerprintCreative } from "@/lib/meridian/intelligence/fingerprint";
import { findWhitespace } from "@/lib/meridian/intelligence/whitespace";
import { rankFromEvidence } from "@/lib/meridian/opportunity/posterior";

function clip(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

export const getStudioBoard = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as { brandId?: unknown }) : {};
    const brandId = clip(body.brandId);
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
    const fingerprints = loaded.creatives.map((creative) => fingerprintCreative(creative, loaded.brain));
    const whitespace = findWhitespace({
      fingerprints,
      origins: loaded.creatives.map((creative) => ({ id: creative.id, origin: creative.origin })),
      brandText: `${loaded.brain.positioning} ${loaded.brain.valueProposition}`,
    });
    const totals = await sql<{ angle: string; clicks: number; impressions: number }>`
      select creatives.angle, coalesce(sum(observations.clicks), 0) as clicks, coalesce(sum(observations.impressions), 0) as impressions
      from performance_observations observations
      join creative_records creatives on creatives.id = observations.creative_id
      where observations.organization_id = ${organizationId} and observations.brand_id = ${data.brandId}
      group by creatives.angle
    `;
    const ranked = rankFromEvidence({
      discovered: whitespace.map((finding) => ({
        id: finding.id,
        source: "discovered" as const,
        label: `Whitespace: ${finding.underused.replaceAll("-", " ")}`,
        angle: finding.underused,
        hookType: "demonstration",
        format: "short_ugc",
        proofType: "demonstration",
        reason: finding.whyTest,
        evidenceIds: finding.evidenceIds,
        alignment: finding.alignsWithBrand ? 0.9 : 0.2,
      })),
      patterns: loaded.patterns,
      performance: totals.map((row) => ({
        angle: row.angle,
        clicks: Number(row.clicks) || 0,
        impressions: Number(row.impressions) || 0,
      })),
      seed: data.brandId,
    });
    return {
      observationCount: loaded.creatives.length,
      whitespace: whitespace.map((finding) => ({
        id: finding.id,
        overused: finding.overused,
        underused: finding.underused,
        whyTest: finding.whyTest,
        confidence: finding.confidence,
        evidenceIds: finding.evidenceIds,
      })),
      discovered: ranked.filter((item) => item.source === "discovered").slice(0, 4),
      exploration: ranked.find((item) => item.source === "exploration") ?? null,
      winning: loaded.patterns.filter((pattern) => pattern.lift > 0).slice(0, 4).map((pattern) => pattern.summary),
      losing: loaded.patterns.filter((pattern) => pattern.lift < 0).slice(0, 4).map((pattern) => pattern.summary),
    };
  });
