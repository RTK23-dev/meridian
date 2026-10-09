import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import { loadBrandContext } from "../context/load.ts";
import type { Sql } from "../learning/store.ts";
import { parsePatternEvidence } from "./patterns.ts";
import { validateResearchAnalysis, type ResearchAnalysis } from "./schema.ts";
import { rebuildOrganizationResearchPatterns, rebuildResearchPatterns } from "./store.ts";

async function brandScope(sql: Sql) {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `org-pat-${suffix}`;
  const brandId = `brand-pat-${suffix}`;
  const jobId = `job-pat-${suffix}`;
  const runId = `run-pat-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, 'test-user')`;
  await sql`
    insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts)
    values (${jobId}, ${organizationId}, ${brandId}, 'research.collect', ${`key-${suffix}`}, 'queued', '{}', 5)
  `;
  await sql`
    insert into research_collection_runs (id, organization_id, brand_id, job_id, search_terms, country, status, created_by)
    values (${runId}, ${organizationId}, ${brandId}, ${jobId}, 'hand soap', 'US', 'collecting', 'test-user')
  `;
  return { organizationId, brandId, runId, suffix };
}

/** A validated analysis whose every field cites seg-1 unless overridden. */
function analysisWith(hookMechanism = "pain_point"): ResearchAnalysis {
  const cite = (value: string) => ({ value, confidence: 0.8, evidence: ["seg-1"] });
  return validateResearchAnalysis({
    topic: cite("hand care"),
    openingMove: cite("problem"),
    hookMechanism: cite(hookMechanism),
    hook: cite("Dry hands?"),
    structure: cite("problem_solution"),
    evidenceOffered: cite("demonstration"),
    emotionalAppeal: cite("relief"),
    adviceSpecificity: cite("actionable"),
    cta: cite("shop_now"),
    segments: [{ id: "seg-1", text: "Dry hands?", startMs: null, endMs: null, role: "hook", confidence: 0.8 }],
    claims: [],
  });
}

/** One analyzed research ad with its creative and analysis run, as the worker leaves them. */
async function analyzedAd(sql: Sql, scope: { organizationId: string; brandId: string; runId: string; suffix: string }, name: string, analysis: ResearchAnalysis) {
  const adId = `ad-${name}-${scope.suffix}`;
  const creativeId = `creative-${name}-${scope.suffix}`;
  const analysisId = `analysis-${name}-${scope.suffix}`;
  await sql`insert into creative_records (id, organization_id, brand_id, origin, created_by) values (${creativeId}, ${scope.organizationId}, ${scope.brandId}, 'competitor', 'test-user')`;
  await sql`
    insert into research_ads (id, organization_id, brand_id, collection_run_id, external_id, advertiser, original_url, captured_at, copy, headline, description, creative_id, analysis_status)
    values (${adId}, ${scope.organizationId}, ${scope.brandId}, ${scope.runId}, ${`ext-${adId}`}, 'Lather Co', 'https://ads.example/x', now(), ${`copy ${name}`}, 'Hands', '', ${creativeId}, 'analyzed')
  `;
  await sql`
    insert into research_analysis_runs (id, organization_id, brand_id, research_ad_id, cache_key, schema_version, provider, model, prompt_version, latency_ms, tokens, status, confidence, review_required, result)
    values (${analysisId}, ${scope.organizationId}, ${scope.brandId}, ${adId}, ${`cache-${name}`}, ${analysis.schemaVersion}, 'test', 'test', 'test', 0, null, 'analyzed', 0.8, false, ${JSON.stringify(analysis)})
  `;
  await sql`update research_ads set analysis_id = ${analysisId} where id = ${adId}`;
  return { adId, creativeId, analysisId };
}

test("a rebuilt brand pattern is stored as INFERRED with the transcript segments of each example, and loads back with them", async () => {
  const sql = await getSql();
  const scope = await brandScope(sql);
  const first = await analyzedAd(sql, scope, "first", analysisWith("pain_point"));
  await analyzedAd(sql, scope, "second", analysisWith("pain_point"));

  await rebuildResearchPatterns(sql, scope.organizationId, scope.brandId);

  const rows = await sql<{ state: string; evidence_refs: string }>`
    select state, evidence_refs from research_patterns
    where organization_id = ${scope.organizationId} and brand_id = ${scope.brandId} and dimension = 'hookMechanism' and value = 'pain_point'
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, "INFERRED");
  const stored = parsePatternEvidence(rows[0]!.evidence_refs);
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.find((entry) => entry.adId === first.creativeId), { adId: first.creativeId, analysisId: first.analysisId, segmentIds: ["seg-1"] });

  const context = await loadBrandContext(sql, scope.organizationId, scope.brandId);
  const loaded = context.researchPatterns.find((pattern) => pattern.dimension === "hookMechanism" && pattern.value === "pain_point");
  assert.ok(loaded);
  assert.equal(loaded.state, "INFERRED");
  assert.equal(loaded.confidenceSource, "model_self_report");
  assert.deepEqual(loaded.evidence, stored);
});

test("organization summaries are INFERRED and carry no example evidence, so no brand's transcript crosses a brand boundary", async () => {
  const sql = await getSql();
  const scope = await brandScope(sql);
  await analyzedAd(sql, scope, "org", analysisWith("curiosity"));

  const patterns = await rebuildOrganizationResearchPatterns(sql, scope.organizationId);
  const mine = patterns.find((pattern) => pattern.dimension === "hookMechanism" && pattern.value === "curiosity");
  assert.ok(mine);
  assert.equal(mine.state, "INFERRED");
  assert.deepEqual(mine.evidence, []);

  const rows = await sql<{ state: string; evidence_refs: string }>`
    select state, evidence_refs from research_patterns
    where organization_id = ${scope.organizationId} and scope = 'organization' and dimension = 'hookMechanism' and value = 'curiosity'
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, "INFERRED");
  assert.equal(rows[0]!.evidence_refs, "[]");
});
