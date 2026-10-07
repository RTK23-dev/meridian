import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { type Role } from "@/lib/meridian/access";
import { SOURCE_ADAPTERS } from "@/lib/meridian/sources/adapters";
import { summarizeUsage } from "@/lib/meridian/observability/usage";
import {
  asText,
  asNumber,
  clip,
  objectInput,
  requireBrand,
} from "./machine-shared";

export type MachineSnapshot = {
  role: Role;
  providerConfigured: boolean;
  provider: string;
  adapters: { id: string; label: string; implemented: boolean; note: string }[];
  counts: {
    competitors: number;
    documents: number;
    observations: number;
    creatives: number;
    openOpportunities: number;
    reviews: number;
    patterns: number;
    performanceRows: number;
  };
  usage: {
    tokens: number;
    costCents: number | null;
    missingCost: number;
  };
  operating: {
    recommendation: { label: string; angle: string; category: string; reason: string; expectedValue: number } | null;
    generationRuns: number;
    publishedTests: number;
    learning: { summary: string; lift: number }[];
  };
};

export const getMachine = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: clip(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<MachineSnapshot> => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "viewer");
    const { providerStatus } = await import("@/lib/meridian/providers/chat.server");
    const provider = providerStatus();
    const count = async (query: string) => {
      const rows = await sql.query<{ count: number }>(query, [data.brandId, access.organizationId]);
      return asNumber(rows[0]?.count);
    };
    const usageRows = (await sql<Record<string, unknown>>`
          select operation, tokens, cost_cents from model_runs
          where brand_id = ${data.brandId} and organization_id = ${access.organizationId}
        `).map((row) => ({
          operation: asText(row.operation),
          tokens: row.tokens == null ? null : asNumber(row.tokens),
          costCents: row.cost_cents == null ? null : asNumber(row.cost_cents),
        }));
    const top = await sql<Record<string, unknown>>`
      select label, angle, category, reason, expected_value from opportunities
      where brand_id = ${data.brandId} and organization_id = ${access.organizationId}
        and status in ('open', 'briefed')
      order by expected_value desc
      limit 1
    `;
    const learned = await sql<Record<string, unknown>>`
      select summary, lift from learned_patterns
      where brand_id = ${data.brandId} and organization_id = ${access.organizationId}
      order by created_at desc
      limit 4
    `;
    const runs = await sql<{ count: number }>`
      select count(*) as count from generation_runs
      where brand_id = ${data.brandId} and organization_id = ${access.organizationId}
    `;
    const published = await sql<{ count: number }>`
      select count(*) as count from provider_objects
      where brand_id = ${data.brandId} and organization_id = ${access.organizationId} and object_type = 'ad'
    `;
    const recommendation = top[0];
    return {
      role: access.role,
      providerConfigured: provider.configured,
      provider: provider.provider,
      adapters: SOURCE_ADAPTERS.map((adapter) => ({ ...adapter })),
      counts: {
        competitors: await count(`select count(*) as count from competitors where brand_id = $1 and organization_id = $2 and status = 'confirmed'`),
        documents: await count(`select count(*) as count from source_documents where brand_id = $1 and organization_id = $2 and status = 'stored'`),
        observations: await count(`select count(*) as count from creative_records where brand_id = $1 and organization_id = $2 and origin = 'competitor'`),
        creatives: await count(`select count(*) as count from creative_records where brand_id = $1 and organization_id = $2 and origin <> 'competitor'`),
        openOpportunities: await count(`select count(*) as count from opportunities where brand_id = $1 and organization_id = $2 and status = 'open'`),
        reviews: await count(`select count(*) as count from reviews where brand_id = $1 and organization_id = $2 and status = 'open'`),
        patterns: await count(`select count(*) as count from learned_patterns where brand_id = $1 and organization_id = $2`),
        performanceRows: await count(`select count(*) as count from performance_observations where brand_id = $1 and organization_id = $2`),
      },
      usage: summarizeUsage(usageRows),
      operating: {
        recommendation: recommendation
          ? {
              label: asText(recommendation.label),
              angle: asText(recommendation.angle),
              category: asText(recommendation.category),
              reason: asText(recommendation.reason),
              expectedValue: asNumber(recommendation.expected_value),
            }
          : null,
        generationRuns: asNumber(runs[0]?.count),
        publishedTests: asNumber(published[0]?.count),
        learning: learned.map((row) => ({ summary: asText(row.summary), lift: asNumber(row.lift) })),
      },
    };
  });

// Research & Market Domain
export {
  getMarket,
  startResearchCollection,
  addCompetitor,
  proposeCompetitors,
  reviewCompetitor,
  recordObservation,
  fetchSourcePage,
  suggestFromDocument,
  resolveSuggestion,
} from "./research/actions";

// Opportunity Domain
export {
  listOpportunities,
  refreshOpportunities,
  dismissOpportunity,
  type OpportunityView,
} from "./opportunity/actions";

// Studio & Creative Domain
export {
  createBriefFromOpportunity,
  composeCreative,
  generateCreative,
  listLibrary,
  getTrace,
  attachCreativeImage,
  getIntelligence,
  storeMaterial,
  uploadLogo,
  listBrandAssets,
} from "./studio/creative-actions";

// Publishing & Reviews Domain
export {
  REVIEW_REASON_CODES,
  listReviews,
  resolveReview,
  publishToPlatform,
} from "./publishing/actions";

// Learning & Performance Domain
export {
  persistLearnedPatterns,
  recordPerformance,
  refreshLearning,
  getLearning,
  setOrganizationLearning,
  sharePatternWithOrganization,
} from "./learning/actions";
