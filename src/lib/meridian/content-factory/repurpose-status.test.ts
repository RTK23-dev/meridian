// The read-only check on an interrupted repurposed cut, on PGlite. The renderer is not reached: the cases here are the ones a status check
// decides without one (not interrupted, and no recorded call). What a renderer reports is mapped in plain words and tested directly.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { FIXTURE_IDS, edlFixture } from "../../../engine/contracts/fixtures/index.ts";
import { writeArtifact } from "../../../engine/jobs/artifact-store.ts";
import { startEngineRequest } from "../../../engine/jobs/orchestrator-sql.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { checkInterruptedRepurposeRender, describeRenderStatus } from "./repurpose-status.ts";

const WS = "ws_repurpose_status";
const BRAND = "brand_repurpose_status";
const ADMIN = "user_repurpose_status_admin";
const MEMBER = "user_repurpose_status_member";
const REQ = FIXTURE_IDS.request;
const SESSION = "session_repurpose_status";
const NOW = "2026-10-24T10:00:00.000Z";
const RUN = "run_repurpose_status_1";
const VARIANT = "interrupted-cut";

let db: TestDatabase;
let childArtifactId = "";

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await db.sql`insert into "user" (id, name, email, "emailVerified") values (${ADMIN}, ${ADMIN}, ${`${ADMIN}@fixture.example`}, true)`;
  await db.sql`insert into "user" (id, name, email, "emailVerified") values (${MEMBER}, ${MEMBER}, ${`${MEMBER}@fixture.example`}, true)`;
  await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${ADMIN}`}, ${WS}, ${ADMIN}, 'admin')`;
  await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${MEMBER}`}, ${WS}, ${MEMBER}, 'member')`;
  await startEngineRequest(db.sql as never, {
    organizationId: WS,
    brandId: BRAND,
    requestId: REQ,
    formatId: "ref_repurpose_status",
    priority: "normal",
    cachedDna: false,
    variantCount: 0,
    requestArtifactId: "art_repurpose_status_request",
  });
  const master = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "edit", type: "edl", body: edlFixture, createdAt: NOW });
  await db.sql`
    update engine_requests set status = 'delivered', state = ${JSON.stringify({ status: "delivered", manifestId: "mf_repurpose_status", masterEdlId: edlFixture.edlId, artifacts: { [`edl:${edlFixture.edlId}`]: master.artifactId } })}
    where id = ${REQ} and organization_id = ${WS}
  `;
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, engine_request_id)
    values (${SESSION}, ${WS}, ${BRAND}, ${ADMIN}, 'Status reel', 'started', ${REQ})
  `;
  childArtifactId = (await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "repurpose", type: "edl", body: edlFixture, parentIds: [master.artifactId], createdAt: NOW })).artifactId;
  // A run with one variation left in rendering, as an interrupted call would leave it, and one variation that is not rendering.
  await db.sql`
    insert into content_factory_repurpose_runs (id, organization_id, brand_id, session_id, engine_request_id, master_edl_id, settings_digest, settings, created_by)
    values (${RUN}, ${WS}, ${BRAND}, ${SESSION}, ${REQ}, ${edlFixture.edlId}, ${"d".repeat(64)}, '{}', ${ADMIN})
  `;
  await db.sql`
    insert into content_factory_repurpose_variants (id, organization_id, run_id, ordinal, variant_key, treatments, visual, child_edl_id, child_artifact_id, status, reason)
    values ('var_status_1', ${WS}, ${RUN}, 0, ${VARIANT}, '[]', '{}', ${edlFixture.edlId}, ${childArtifactId}, 'rendering', ''),
           ('var_status_2', ${WS}, ${RUN}, 1, 'planned-cut', '[]', '{}', ${edlFixture.edlId}, ${childArtifactId}, 'planned', '')
  `;
});

after(async () => {
  await db.close();
});

describe("the read-only check on an interrupted repurposed cut", () => {
  test("a cut that is not rendering is not checked, and the renderer is not asked", async () => {
    let asked = 0;
    const result = await checkInterruptedRepurposeRender(db.sql, ADMIN, { sessionId: SESSION, runId: RUN, variantKey: "planned-cut" }, async () => {
      asked += 1;
      return { status: "completed" };
    });
    assert.equal(result.status, "not_interrupted");
    assert.equal(asked, 0);
  });

  test("a rendering cut with no recorded renderer call says so, and the renderer is not asked", async () => {
    let asked = 0;
    const result = await checkInterruptedRepurposeRender(db.sql, ADMIN, { sessionId: SESSION, runId: RUN, variantKey: VARIANT }, async () => {
      asked += 1;
      return { status: "completed" };
    });
    assert.equal(result.status, "no_provider_call");
    assert.equal(asked, 0, "nothing to ask: no renderer call was recorded");
    const row = await db.sql<{ status: string }>`select status from content_factory_repurpose_variants where run_id = ${RUN} and variant_key = ${VARIANT}`;
    assert.equal(row[0]?.status, "rendering", "a check changes nothing");
  });

  test("a member who is not an admin cannot check, and reads nothing", async () => {
    await assert.rejects(checkInterruptedRepurposeRender(db.sql, MEMBER, { sessionId: SESSION, runId: RUN, variantKey: VARIANT }, async () => ({ status: "completed" })), /admin/i);
  });

  test("a completed render is reported as completed, and the cut stays in rendering", () => {
    assert.match(describeRenderStatus({ status: "completed" }), /completed.*stays in rendering/);
  });

  test("a failed render says it was failed, and that billing is not confirmed by the check", () => {
    const text = describeRenderStatus({ status: "failed", failureMessage: "the scene did not compose" });
    assert.match(text, /failed: the scene did not compose/);
    assert.match(text, /Whether it was billed is not confirmed/);
  });

  test("any other status is named as it is, and the cut stays in rendering", () => {
    assert.match(describeRenderStatus({ status: "queued" }), /as queued\. The cut stays in rendering\./);
  });
});
