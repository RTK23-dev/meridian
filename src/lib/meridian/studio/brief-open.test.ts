import assert from "node:assert/strict";
import test from "node:test";
import { createPoolSql, getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { BRAIN, BRIEF, approvesBriefCalibrated, registryWith, stubEngine } from "../testing/brief-fixtures.ts";
import {
  failingSql,
  seedBrandBrain,
  seedCompetitorCreative,
  seedOpportunity,
} from "../testing/opportunity-fixtures.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import type { BriefGateOptions } from "./brief-service.server.ts";
import { briefGateJudge, createGatedBrief } from "./brief-service.server.ts";
import type { BriefRecord } from "./brief-service.contract.ts";

// The opening path and the direction recorder import the server-function layer, which uses the "@/" alias.
enableAppAliases();
const { openStudioBriefFor } = await import("./brief-open.server.ts");

const PG_TEST_URL = process.env.MERIDIAN_PG_TEST_URL?.trim();
const REASON = "The stored competitor evidence supports this direction for the brief.";
const DISCOVERED_ANGLE = "quiet_dinner_speed";

function autoApproveGate(): BriefGateOptions {
  return {
    engines: registryWith(stubEngine("jev", { respond: approvesBriefCalibrated }), stubEngine("openai-decisions")),
    selection: { engineId: "jev", source: "workspace" },
  };
}

function briefRecord(opportunityId: string | null): BriefRecord {
  return {
    opportunityId,
    title: "Chosen direction brief",
    audience: BRIEF.audience,
    angle: BRIEF.angle,
    hook: BRIEF.hook,
    message: BRIEF.message,
    offer: "",
    cta: BRIEF.cta,
    format: BRIEF.format,
    proofType: "",
    constraints: "",
    context: {},
    workflow: "test",
    why: [],
    learningNotes: [],
    failureNotes: [],
  };
}

async function opportunityStatus(sql: Sql, id: string): Promise<string | undefined> {
  const [row] = await sql<{ status: string }>`select status from opportunities where id = ${id}`;
  return row?.status;
}

async function directionCount(sql: Sql, opportunityId: string): Promise<number> {
  const [row] = await sql<{ count: number }>`
    select count(*)::int as count from opportunity_direction_decisions where opportunity_id = ${opportunityId}
  `;
  return row?.count ?? 0;
}

test("a named opportunity is briefed: the brief is written for it, and the other open direction is kept as it was", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "open-named");
  await seedBrandBrain(sql, tenant);
  await seedCompetitorCreative(sql, tenant, DISCOVERED_ANGLE);
  const other = await seedOpportunity(sql, tenant, { angle: "other_direction_open" });
  const chosen = await seedOpportunity(sql, tenant, { angle: "chosen_direction_open" });
  await openStudioBriefFor(sql, tenant.userId, { brandId: tenant.brandId, forceNew: false, reason: REASON, opportunityId: chosen.opportunityId }, autoApproveGate());
  const [brief] = await sql<{ opportunity_id: string; status: string }>`
    select opportunity_id, status from briefs where brand_id = ${tenant.brandId} and opportunity_id is not null
  `;
  assert.equal(brief?.opportunity_id, chosen.opportunityId, "the brief is written for the opportunity that was chosen");
  assert.equal(brief?.status, "ready");
  assert.equal(await opportunityStatus(sql, chosen.opportunityId), "briefed");
  assert.equal(await opportunityStatus(sql, other.opportunityId), "open", "the other opportunity is not rebuilt or touched");
  assert.equal(await directionCount(sql, chosen.opportunityId), 1, "the direction is recorded for the chosen opportunity");
});

test("a named opportunity in another brand is not found, and no direction is recorded for it", async () => {
  const sql = await getSql();
  const mine = await studioTenant(sql, "open-tenancy-mine");
  const theirs = await studioTenant(sql, "open-tenancy-theirs");
  await seedBrandBrain(sql, mine);
  const foreign = await seedOpportunity(sql, theirs, { angle: "foreign_direction_open" });
  await assert.rejects(
    openStudioBriefFor(sql, mine.userId, { brandId: mine.brandId, forceNew: false, reason: REASON, opportunityId: foreign.opportunityId }, autoApproveGate()),
    /Opportunity not found/,
  );
  assert.equal(await directionCount(sql, foreign.opportunityId), 0, "no direction is recorded across tenants");
  assert.equal(await opportunityStatus(sql, foreign.opportunityId), "open", "the other brand's opportunity is unchanged");
});

test("a named opportunity that is not open, or not a discovered direction, is refused before anything is written", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "open-state");
  await seedBrandBrain(sql, tenant);
  const briefed = await seedOpportunity(sql, tenant, { angle: "already_briefed_direction", status: "briefed" });
  await assert.rejects(
    openStudioBriefFor(sql, tenant.userId, { brandId: tenant.brandId, forceNew: false, reason: REASON, opportunityId: briefed.opportunityId }, autoApproveGate()),
    /cannot be briefed now, because it is briefed/,
  );
  assert.equal(await directionCount(sql, briefed.opportunityId), 0);

  const prior = await seedOpportunity(sql, tenant, { angle: "prior_direction_open" });
  await sql`update opportunities set hypothesis_id = 'prior:seed-direction' where id = ${prior.opportunityId}`;
  await assert.rejects(
    openStudioBriefFor(sql, tenant.userId, { brandId: tenant.brandId, forceNew: false, reason: REASON, opportunityId: prior.opportunityId }, autoApproveGate()),
    /Only a discovered direction can be briefed here/,
  );
  assert.equal(await directionCount(sql, prior.opportunityId), 0);
  assert.equal(await opportunityStatus(sql, prior.opportunityId), "open");
});

/**
 * A replacement retires the older ready brief of the same opportunity in the same transaction as the new brief. A failure in
 * the retirement leaves the new brief unwritten and the older one ready. The same check runs on PGlite and on PostgreSQL.
 */
async function replacementIsAtomic(sql: Sql) {
  const tenant = await studioTenant(sql, `replace-atomic-${Math.random().toString(36).slice(2, 7)}`);
  const { opportunityId } = await seedOpportunity(sql, tenant, { angle: "replaced_direction_open" });
  const judgeFor = (briefId: string) =>
    briefGateJudge(sql, {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      brief: BRIEF,
      brain: BRAIN,
      ...autoApproveGate(),
    })(briefId);
  const older = await createGatedBrief(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    createdBy: tenant.userId,
    brief: briefRecord(opportunityId),
    judge: judgeFor,
  });
  assert.equal(older.status, "ready");

  let newBriefId = "";
  await assert.rejects(
    createGatedBrief(failingSql(sql, /update briefs set status = 'used'/), {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      createdBy: tenant.userId,
      brief: briefRecord(opportunityId),
      supersedeReady: true,
      judge: (briefId) => {
        newBriefId = briefId;
        return judgeFor(briefId);
      },
    }),
    /injected write failure/,
  );
  const [created] = await sql<{ count: number }>`select count(*)::int as count from briefs where id = ${newBriefId}`;
  assert.equal(created?.count, 0, "the failed replacement wrote no new brief");
  const [olderRow] = await sql<{ status: string }>`select status from briefs where id = ${older.briefId}`;
  assert.equal(olderRow?.status, "ready", "the older brief is still ready after the failed replacement");

  const replaced = await createGatedBrief(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    createdBy: tenant.userId,
    brief: briefRecord(opportunityId),
    supersedeReady: true,
    judge: judgeFor,
  });
  assert.equal(replaced.status, "ready");
  const [retired] = await sql<{ status: string }>`select status from briefs where id = ${older.briefId}`;
  assert.equal(retired?.status, "used", "the replacement retires the older brief");
  const [ready] = await sql<{ count: number }>`
    select count(*)::int as count from briefs where opportunity_id = ${opportunityId} and status = 'ready'
  `;
  assert.equal(ready?.count, 1, "exactly one ready brief remains for the opportunity");
}

test("PGlite: a failed replacement leaves the older ready brief in place, and a successful one retires it", async () => {
  await replacementIsAtomic(await getSql());
});

test("PostgreSQL: a failed replacement leaves the older ready brief in place, and a successful one retires it", async (t) => {
  if (!PG_TEST_URL) {
    t.skip("MERIDIAN_PG_TEST_URL is not set, so the PostgreSQL replacement check was not run");
    return;
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: PG_TEST_URL });
  try {
    await replacementIsAtomic(createPoolSql(pool));
  } finally {
    await pool.end();
  }
});
