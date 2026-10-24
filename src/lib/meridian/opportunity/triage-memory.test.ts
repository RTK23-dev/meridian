// Triage memory: an idea a person declined, or already explored, is not put back in front of them as new by a refresh. The matcher is pure;
// the end-to-end test ranks a real brand on PGlite (every migration), declines one idea and accepts another, ranks again, and checks that
// neither comes back open and that an idea which differs in any part of its fingerprint is still offered.

import assert from "node:assert/strict";
import { after, before, describe, it, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { rerankBrand } from "./rerank.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import { fingerprintKey, priorIdeaFor, priorIdeasByFingerprint, type PriorIdea } from "./triage-memory.ts";
import { readPriorIdeas } from "./triage-memory-store.ts";

// The refresh action imports modules that use the "@/" alias, so the alias hook is registered before it is loaded.
enableAppAliases();
const { refreshOpportunitiesFor, recordOpportunityDirection } = await import("./actions.ts");

const WS = "org_triage";
const BRAND = "brand_triage";
const USER = "user_triage";

function prior(overrides: Partial<PriorIdea>): PriorIdea {
  return {
    opportunityId: "opp_x",
    label: "x",
    hypothesisId: "h1",
    productId: "p1",
    angle: "lather",
    format: "short_ugc",
    outcome: "declined",
    reason: "the claim is not ours to make",
    decidedAt: "2026-10-01T10:00:00Z",
    ...overrides,
  };
}

describe("the fingerprint of an idea", () => {
  it("is the same for the same hypothesis, product, angle and format, and differs when any part differs", () => {
    const base = { hypothesisId: "h1", productId: "p1", angle: "lather", format: "short_ugc" };
    assert.equal(fingerprintKey(base), fingerprintKey({ ...base }));
    assert.notEqual(fingerprintKey(base), fingerprintKey({ ...base, angle: "proof" }));
    assert.notEqual(fingerprintKey(base), fingerprintKey({ ...base, format: "static" }));
    assert.notEqual(fingerprintKey(base), fingerprintKey({ ...base, productId: null }));
  });
});

describe("matching a draft against prior ideas", () => {
  it("matches a draft with the same fingerprint, and no other", () => {
    const byKey = priorIdeasByFingerprint([prior({})]);
    assert.equal(priorIdeaFor({ hypothesisId: "h1", productId: "p1", angle: "lather", format: "short_ugc" }, byKey)?.outcome, "declined");
    assert.equal(priorIdeaFor({ hypothesisId: "h1", productId: "p1", angle: "proof", format: "short_ugc" }, byKey), null);
  });

  it("prefers an explored idea over a declined one with the same fingerprint, because it was pursued", () => {
    const byKey = priorIdeasByFingerprint([prior({ outcome: "declined" }), prior({ outcome: "explored", reason: null, opportunityId: "opp_y" })]);
    assert.equal(priorIdeaFor({ hypothesisId: "h1", productId: "p1", angle: "lather", format: "short_ugc" }, byKey)?.outcome, "explored");
  });

  it("prefers the newest decision among declined ideas with the same fingerprint", () => {
    const byKey = priorIdeasByFingerprint([
      prior({ opportunityId: "old", decidedAt: "2026-09-01T10:00:00Z" }),
      prior({ opportunityId: "new", decidedAt: "2026-10-05T10:00:00Z" }),
    ]);
    assert.equal(priorIdeaFor({ hypothesisId: "h1", productId: "p1", angle: "lather", format: "short_ugc" }, byKey)?.opportunityId, "new");
  });
});

/** The fingerprint of an opportunity row as the database returns it. */
function keyOfRow(row: { hypothesis_id: string; product_id: string | null; angle: string; format: string }): string {
  return fingerprintKey({ hypothesisId: row.hypothesis_id, productId: row.product_id, angle: row.angle, format: row.format });
}

describe("triage memory on a real brand", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, WS, BRAND);
    await db.sql`insert into "user" (id, name, email, "emailVerified") values (${USER}, ${USER}, ${`${USER}@fixture.example`}, true)`;
    await db.sql`
      insert into brand_brains (brand_id, target_customers, positioning, value_proposition, tone, prohibited_claims, updated_by)
      values (${BRAND}, 'Busy parents', 'Helps busy parents plan a calm dinner in ten minutes.', 'Planned dinners with no planning.', 'warm', 'guaranteed', ${USER})
    `;
    await db.sql`
      insert into products (id, brand_id, name, description, allowed_claims, prohibited_claims, created_by)
      values ('prod_triage', ${BRAND}, 'Dinner kit', 'A calm dinner plan for busy parents.', 'plans dinner', 'guaranteed', ${USER})
    `;
  });

  after(async () => {
    await db.close();
  });

  it("keeps a declined idea and an accepted idea out of the next refresh, and still offers the rest", async () => {
    const first = await rerankBrand(db.sql, WS, BRAND);
    assert.ok(first >= 3, `the first refresh writes several ideas from the brand's own context (got ${first})`);
    const open = await db.sql<{ id: string; hypothesis_id: string; product_id: string | null; angle: string; format: string }>`
      select id, hypothesis_id, product_id, angle, format from opportunities
      where organization_id = ${WS} and brand_id = ${BRAND} and status = 'open' order by id
    `;
    const [declined, accepted] = open;
    assert.ok(declined && accepted, "two open ideas to decide");

    await db.sql`update opportunities set status = 'dismissed' where id = ${declined.id}`;
    await db.sql`
      insert into opportunity_direction_decisions (id, organization_id, brand_id, opportunity_id, actor_id, actor_role, action, reason)
      values ('dir_triage_decline', ${WS}, ${BRAND}, ${declined.id}, ${USER}, 'member', 'decline', 'Dinner planning is not what this brand sells')
    `;
    await db.sql`update opportunities set status = 'accepted' where id = ${accepted.id}`;

    const prior = await readPriorIdeas(db.sql, WS, BRAND);
    assert.deepEqual(
      prior.map((item) => [item.opportunityId, item.outcome, item.reason !== null]).sort(),
      [[accepted.id, "explored", false], [declined.id, "declined", true]].sort(),
      "the declined idea carries its reason, and the accepted one is explored",
    );

    const second = await rerankBrand(db.sql, WS, BRAND);
    const reopened = await db.sql<{ hypothesis_id: string; product_id: string | null; angle: string; format: string }>`
      select hypothesis_id, product_id, angle, format from opportunities
      where organization_id = ${WS} and brand_id = ${BRAND} and status = 'open'
    `;
    const keys = new Set(reopened.map((row) => fingerprintKey({ hypothesisId: row.hypothesis_id, productId: row.product_id, angle: row.angle, format: row.format })));
    assert.equal(keys.has(keyOfRow(declined)), false, "a declined idea does not come back open");
    assert.equal(keys.has(keyOfRow(accepted)), false, "an idea already explored does not come back open");
    assert.equal(second, reopened.length, "the count is the ideas written, not the ideas ranked");
    assert.ok(second >= 1 && second < first, `the rest are still offered (first ${first}, second ${second})`);
  });

  it("a decline needs the reason in full: a short reason is refused and writes nothing", async () => {
    const [open] = await db.sql<{ id: string; status: string }>`
      select id, status from opportunities where organization_id = ${WS} and brand_id = ${BRAND} and status = 'open' limit 1
    `;
    assert.ok(open, "an open idea to decline");
    await assert.rejects(
      recordOpportunityDirection(db.sql, {
        organizationId: WS,
        brandId: BRAND,
        opportunityId: open.id,
        actorId: USER,
        actorRole: "member",
        action: "decline",
        reason: "too short",
      }),
      /at least 20 characters/,
    );
    const [after] = await db.sql<{ status: string }>`select status from opportunities where id = ${open.id}`;
    assert.equal(after?.status, "open", "a refused decline leaves the idea open");
    const records = await db.sql<{ n: number }>`select count(*)::int as n from opportunity_direction_decisions where opportunity_id = ${open.id}`;
    assert.equal(records[0]?.n, 0, "and records no decision");
  });

  it("the refresh action the person triggers keeps the same ideas out, and reports how many it kept out", async () => {
    await db.sql`insert into memberships (id, organization_id, user_id, role) values ('mem_triage', ${WS}, ${USER}, 'member')`;
    const before = await db.sql<{ id: string }>`select id from opportunities where organization_id = ${WS} and brand_id = ${BRAND} and status = 'open'`;
    const declined = await db.sql<{ hypothesis_id: string; product_id: string | null; angle: string; format: string }>`
      select o.hypothesis_id, o.product_id, o.angle, o.format from opportunities o
      join opportunity_direction_decisions d on d.opportunity_id = o.id and d.action = 'decline'
      where o.organization_id = ${WS} and o.brand_id = ${BRAND}
    `;
    assert.equal(declined.length, 1, "the earlier decline is on record");
    const result = await refreshOpportunitiesFor(db.sql, USER, BRAND);
    assert.ok(result.suppressed >= 1, `the declined idea is counted as suppressed (got ${result.suppressed})`);
    const after = await db.sql<{ hypothesis_id: string; product_id: string | null; angle: string; format: string }>`
      select hypothesis_id, product_id, angle, format from opportunities where organization_id = ${WS} and brand_id = ${BRAND} and status = 'open'
    `;
    const keys = after.map((row) => fingerprintKey({ hypothesisId: row.hypothesis_id, productId: row.product_id, angle: row.angle, format: row.format }));
    const [gone] = declined;
    assert.ok(gone, "the declined idea's fingerprint is known");
    const goneKey = fingerprintKey({ hypothesisId: gone.hypothesis_id, productId: gone.product_id, angle: gone.angle, format: gone.format });
    assert.ok(goneKey.split("|")[0], "the fingerprint has its hypothesis, so the check cannot pass on a blank key");
    assert.equal(keys.includes(goneKey), false, "the declined idea does not come back open");
    assert.equal(result.count, after.length, "the count is the ideas written");
    assert.ok(before.length >= 1);
  });
});

test("a brand with no prior decisions suppresses nothing", async () => {
  assert.deepEqual(priorIdeasByFingerprint([]).size, 0);
});
