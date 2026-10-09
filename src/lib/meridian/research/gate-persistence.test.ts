import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { applyCheapGate, type GateCandidate } from "./gate.ts";

async function brandRun(sql: Sql) {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `org-gate-${suffix}`;
  const brandId = `brand-gate-${suffix}`;
  const jobId = `job-gate-${suffix}`;
  const runId = `run-gate-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, 'test-user')`;
  await sql`
    insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts)
    values (${jobId}, ${organizationId}, ${brandId}, 'research.collect', ${`key-${suffix}`}, 'queued', '{}', 5)
  `;
  await sql`
    insert into research_collection_runs (id, organization_id, brand_id, job_id, search_terms, country, status, created_by)
    values (${runId}, ${organizationId}, ${brandId}, ${jobId}, 'sponge', 'US', 'collecting', 'test-user')
  `;
  return { organizationId, brandId, runId };
}

async function insertAd(sql: Sql, scope: { organizationId: string; brandId: string; runId: string }, id: string, copy: string) {
  await sql`
    insert into research_ads (id, organization_id, brand_id, collection_run_id, external_id, advertiser, original_url, captured_at, copy, headline, description)
    values (${id}, ${scope.organizationId}, ${scope.brandId}, ${scope.runId}, ${`ext-${id}`}, 'Lather Co', 'https://ads.example/x', now(), ${copy}, 'Mesh sponge', '')
  `;
}

function candidate(id: string, copy: string, publishedAt: string): GateCandidate {
  return { adId: id, externalId: `ext-${id}`, copy, headline: "Mesh sponge", description: "", capturedAt: publishedAt, publishedAt };
}

const uniq = (scope: { runId: string }, name: string) => `${scope.runId}:${name}`;

test("the gate records each decision on its ad: skipped ads are gate_skipped with a reason, admitted ads keep their status", async () => {
  const sql = await getSql();
  const scope = await brandRun(sql);
  await insertAd(sql, scope, uniq(scope, "ad-new"), "Tired of smelly sponges? Try the mesh sponge.");
  await insertAd(sql, scope, uniq(scope, "ad-dup"), "Tired of smelly sponges? Try the mesh sponge.");
  await insertAd(sql, scope, uniq(scope, "ad-old"), "Stays fresh longer than other sponges.");

  const decision = await applyCheapGate(sql, {
    ...scope,
    maxAdsPerRun: 1,
    candidates: [
      candidate(uniq(scope, "ad-new"), "Tired of smelly sponges? Try the mesh sponge.", "2026-10-06T00:00:00.000Z"),
      candidate(uniq(scope, "ad-dup"), "Tired of smelly sponges? Try the mesh sponge.", "2026-10-05T00:00:00.000Z"),
      candidate(uniq(scope, "ad-old"), "Stays fresh longer than other sponges.", "2026-09-01T00:00:00.000Z"),
    ],
  });
  assert.deepEqual(decision.admitted, [uniq(scope, "ad-new")]);

  const rows = await sql<{ id: string; analysis_status: string; gate_reason: string; gate_score: number }>`
    select id, analysis_status, gate_reason, gate_score from research_ads where collection_run_id = ${scope.runId} order by id
  `;
  const byId = Object.fromEntries(rows.map((row) => [row.id.slice(scope.runId.length + 1), row]));
  assert.equal(byId["ad-new"]!.analysis_status, "pending", "an admitted ad stays pending for the expensive steps");
  assert.equal(byId["ad-new"]!.gate_reason, "admitted");
  assert.equal(byId["ad-dup"]!.analysis_status, "gate_skipped");
  assert.equal(byId["ad-dup"]!.gate_reason, "duplicate_in_run");
  assert.equal(byId["ad-old"]!.analysis_status, "gate_skipped");
  assert.equal(byId["ad-old"]!.gate_reason, "below_run_cap");
  assert.ok(Number(byId["ad-new"]!.gate_score) > Number(byId["ad-old"]!.gate_score));
});

test("the gate does not reuse another brand's analyses, so one brand's analysis cannot skip another brand's ad", async () => {
  const sql = await getSql();
  const mine = await brandRun(sql);
  const theirs = await brandRun(sql);
  await insertAd(sql, theirs, uniq(theirs, "their-analyzed"), "Only our brand's shared copy.");
  await sql`update research_ads set analysis_status = 'analyzed' where id = ${uniq(theirs, "their-analyzed")}`;
  await insertAd(sql, mine, uniq(mine, "mine"), "Only our brand's shared copy.");

  const decision = await applyCheapGate(sql, {
    ...mine,
    maxAdsPerRun: 5,
    candidates: [candidate(uniq(mine, "mine"), "Only our brand's shared copy.", "2026-10-06T00:00:00.000Z")],
  });
  assert.deepEqual(decision.admitted, [uniq(mine, "mine")]);
});

test("a retried run does not demote an ad it already analyzed, and does not skip that ad as a copy of itself", async () => {
  const sql = await getSql();
  const scope = await brandRun(sql);
  const id = uniq(scope, "already-analyzed");
  await insertAd(sql, scope, id, "Lasting softness, one sponge at a time.");
  await sql`update research_ads set analysis_status = 'analyzed' where id = ${id}`;

  const decision = await applyCheapGate(sql, {
    ...scope,
    maxAdsPerRun: 5,
    candidates: [candidate(id, "Lasting softness, one sponge at a time.", "2026-10-06T00:00:00.000Z")],
  });
  assert.deepEqual(decision.admitted, [id]);
  const rows = await sql<{ analysis_status: string }>`select analysis_status from research_ads where id = ${id}`;
  assert.equal(rows[0]!.analysis_status, "analyzed", "the earlier analysis is kept");
});
