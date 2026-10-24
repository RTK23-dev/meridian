// A repurposed variation's library creative, and its organic publish to a Facebook Page, on PGlite with a fake Facebook. Nothing here reaches
// Facebook: the fake answers the Page video POST, and counts every request. The tests cover the link (once, from a reviewed and rights-cleared
// rendered video), the publish (once, with a receipt the telemetry reads), and each way a request can fail.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { writeArtifact } from "../../../engine/jobs/artifact-store.ts";
import { startEngineRequest } from "../../../engine/jobs/orchestrator-sql.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import type { Transport, TransportRequest, TransportResponse } from "../providers/http.ts";
import { linkRepurposedVariantCreative, repurposedVariantSource } from "./repurpose-creative.ts";
import { publishRepurposedVariantWith, sqlOrganicStore, type OrganicPublishRequest } from "./repurpose-organic.ts";

const WS = "ws_repurpose_organic";
const OUTSIDER_WS = "ws_repurpose_outsider";
const BRAND = "brand_repurpose_organic";
const ADMIN = "user_organic_admin";
const MEMBER = "user_organic_member";
const OUTSIDER = "user_organic_outsider";
const REQUEST = "req_01HZ8Z3K7M9P2Q4R6S8T0V1W2X";
const SESSION = "session_organic_fixture";
const RUN = "run_organic_fixture";
const PAGE = "1020";
const NOW = new Date("2026-10-24T12:00:00.000Z");
const MEDIA = new TextEncoder().encode("rendered video bytes for the organic fixture");

let db: TestDatabase;
let approvedVariant = "";
let unapprovedVariant = "";

/** The object store the artifact writer and reader use, in memory. It keeps the bytes and the mime type under the storage key. */
function memoryPort() {
  const objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  return {
    async put(input: { organizationId: string; brandId: string; key: string; mimeType: string; bytes: Uint8Array }) {
      objects.set(`${input.organizationId}|${input.brandId}|${input.key}`, { bytes: input.bytes, mimeType: input.mimeType });
      return { key: input.key, checksum: "fixture", size: input.bytes.byteLength };
    },
    async get(organizationId: string, brandId: string, key: string) {
      return objects.get(`${organizationId}|${brandId}|${key}`) ?? null;
    },
  };
}

function reply(status: number, body: unknown): TransportResponse {
  return { status, body: JSON.stringify(body), headers: {} };
}

/** A fake Facebook Page. Each POST to a Page's videos edge gets the next scripted answer; a scripted "lose" answer still records the post. */
function fakeFacebook(script: ("ok" | "lose" | "forbidden" | "server" | "rate_limited")[] = []) {
  const posts: TransportRequest[] = [];
  let next = 1;
  const transport: Transport = async (request) => {
    if (request.method !== "POST" || !request.url.endsWith("/videos")) throw new Error(`fake Facebook: unexpected ${request.method} ${request.url}`);
    posts.push(request);
    const answer = script.shift() ?? "ok";
    if (answer === "lose") {
      throw new Error("connection reset after the video was accepted");
    }
    if (answer === "forbidden") return reply(403, { error: { code: 200, message: "permission denied" } });
    if (answer === "server") return reply(500, { error: { message: "server error" } });
    if (answer === "rate_limited") return reply(429, { error: { code: 4, message: "too many calls" } });
    return reply(200, { id: `fb_video_${next++}` });
  };
  return { transport, posts };
}

const CONNECTION = { connected: true as const, platform: "facebook" as const, accountId: PAGE, accountName: "Fixture Page", accessToken: "test-token-not-logged", scopes: null };

async function sourceFor(variantKey: string) {
  const eligible = await repurposedVariantSource(db.sql, ADMIN, { sessionId: SESSION, runId: RUN, variantKey });
  assert.equal(eligible.ok, true, `variation ${variantKey} is eligible`);
  return eligible.ok ? eligible.source : (null as never);
}

function requestFor(source: Awaited<ReturnType<typeof sourceFor>>, changes: Partial<OrganicPublishRequest> = {}): OrganicPublishRequest {
  return {
    source,
    creativeId: changes.creativeId ?? "",
    assetId: changes.assetId ?? "",
    pageId: PAGE,
    createdBy: ADMIN,
    caption: "A caption",
    title: "A title",
    mediaBytes: MEDIA,
    mimeType: "video/mp4",
    connection: CONNECTION,
    confirmRetry: false,
    ...changes,
  };
}

async function linkedRequest(variantKey: string, changes: Partial<OrganicPublishRequest> = {}): Promise<OrganicPublishRequest> {
  const source = await sourceFor(variantKey);
  const linked = await linkRepurposedVariantCreative(db.sql, { ...source, createdBy: ADMIN });
  return requestFor(source, { creativeId: linked.creativeId, assetId: linked.assetId, ...changes });
}

async function organicPostsFor(creativeId: string): Promise<number> {
  const rows = await db.sql<{ n: number }>`select count(*)::int as n from organic_posts where creative_id = ${creativeId} and surface = 'organic'`;
  return rows[0]?.n ?? 0;
}

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await seedWorkspace(db.sql, OUTSIDER_WS);
  for (const [id, name] of [
    [ADMIN, "admin"],
    [MEMBER, "member"],
    [OUTSIDER, "outsider"],
  ] as const) {
    await db.sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${name}, ${`${id}@fixture.example`}, true)`;
  }
  await db.sql`insert into memberships (id, organization_id, user_id, role) values ('mem_org_admin', ${WS}, ${ADMIN}, 'admin')`;
  await db.sql`insert into memberships (id, organization_id, user_id, role) values ('mem_org_member', ${WS}, ${MEMBER}, 'member')`;

  await startEngineRequest(db.sql as never, {
    organizationId: WS,
    brandId: BRAND,
    requestId: REQUEST,
    formatId: "ref_organic_fixture",
    priority: "normal",
    cachedDna: false,
    variantCount: 0,
    requestArtifactId: "art_organic_request",
  });
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, engine_request_id)
    values (${SESSION}, ${WS}, ${BRAND}, ${ADMIN}, 'Organic fixture', 'started', ${REQUEST})
  `;
  await db.sql`
    insert into content_factory_repurpose_runs (id, organization_id, brand_id, session_id, engine_request_id, master_edl_id, settings_digest, settings)
    values (${RUN}, ${WS}, ${BRAND}, ${SESSION}, ${REQUEST}, 'edl_organic', 'digest_organic', '{}')
  `;

  const port = memoryPort();
  const artifact = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQUEST,
    stage: "render",
    type: "rendered_video",
    createdAt: NOW.toISOString(),
    body: {
      videoId: "vid_01HZ8Z3K7M9P2Q4R6S8T0V1W2X",
      edlId: "edl_01HZ8Z3K7M9P2Q4R6S8T0V1W2X",
      uri: "organic-fixture-video",
      renderer: "fixture",
      durationMs: 10000,
      bytes: MEDIA.byteLength,
      estimateUsd: 0,
      costUsd: null,
      idempotencyKey: `sha256:${"a".repeat(64)}`,
    },
    media: { store: port, brandId: BRAND, extension: "mp4", bytes: MEDIA },
  });
  approvedVariant = "variation-approved";
  unapprovedVariant = "variation-unapproved";
  for (const [key, status] of [
    [approvedVariant, "approved"],
    [unapprovedVariant, "unapproved"],
  ] as const) {
    const variantId = `variant_organic_${key}`;
    await db.sql`
      insert into content_factory_repurpose_variants (id, organization_id, run_id, ordinal, variant_key, treatments, visual, child_edl_id, child_artifact_id, status, rendered_artifact_id)
      values (${variantId}, ${WS}, ${RUN}, ${key === approvedVariant ? 0 : 1}, ${key}, '[]', 'fixture', 'edl_child', 'art_child', 'rendered', ${artifact.artifactId})
    `;
    if (status === "approved") {
      await db.sql`
        insert into content_factory_repurpose_reviews (id, organization_id, run_id, variant_key, rendered_artifact_id, decision, reason, rights_record_ids, actor_id)
        values ('review_organic_fixture', ${WS}, ${RUN}, ${key}, ${artifact.artifactId}, 'approved', '', '[]', ${ADMIN})
      `;
    }
  }
});

after(async () => {
  await db.close();
});

describe("the library creative of a reviewed variation", () => {
  test("a reviewed, rendered, rights-cleared variation becomes one approved creative with an asset that points at its own stored video", async () => {
    const source = await sourceFor(approvedVariant);
    const first = await linkRepurposedVariantCreative(db.sql, { ...source, createdBy: ADMIN });
    assert.equal(first.created, true);
    const creative = (await db.sql<{ status: string; origin: string; repurpose_variant_id: string }>`
      select status, origin, repurpose_variant_id from creative_records where id = ${first.creativeId}
    `)[0]!;
    assert.equal(creative.status, "approved");
    assert.equal(creative.origin, "generated");
    assert.equal(creative.repurpose_variant_id, source.variantId, "the lineage names the variation");

    const asset = (await db.sql<{ storage_key: string; source: string; creative_id: string }>`
      select storage_key, source, creative_id from assets where id = ${first.assetId}
    `)[0]!;
    assert.equal(asset.source, "repurpose");
    assert.equal(asset.creative_id, first.creativeId);
    assert.notEqual(asset.storage_key, "", "the asset names the stored video");
  });

  test("a second link returns the same creative and asset, and creates no second library entry", async () => {
    const source = await sourceFor(approvedVariant);
    const again = await linkRepurposedVariantCreative(db.sql, { ...source, createdBy: ADMIN });
    assert.equal(again.created, false);
    const count = (await db.sql<{ n: number }>`select count(*)::int as n from creative_records where repurpose_variant_id = ${source.variantId}`)[0]!.n;
    assert.equal(count, 1);
    const assets = (await db.sql<{ n: number }>`select count(*)::int as n from assets where creative_id = ${again.creativeId}`)[0]!.n;
    assert.equal(assets, 1, "no second asset, and no copy of the video");
  });

  test("a variation nobody has approved is refused, and nothing is linked", async () => {
    const eligible = await repurposedVariantSource(db.sql, ADMIN, { sessionId: SESSION, runId: RUN, variantKey: unapprovedVariant });
    assert.equal(eligible.ok, false);
    const count = (await db.sql<{ n: number }>`select count(*)::int as n from creative_records where repurpose_variant_id = ${`variant_organic_${unapprovedVariant}`}`)[0]!.n;
    assert.equal(count, 0);
  });

  test("a member is refused: reading a variation's eligibility is an admin action", async () => {
    await assert.rejects(repurposedVariantSource(db.sql, MEMBER, { sessionId: SESSION, runId: RUN, variantKey: approvedVariant }));
  });

  test("a user of another workspace is refused for this session", async () => {
    await assert.rejects(repurposedVariantSource(db.sql, OUTSIDER, { sessionId: SESSION, runId: RUN, variantKey: approvedVariant }));
  });
});

describe("publishing a variation to a Facebook Page", () => {
  test("one post is made, recorded as an organic post with its receipt, and a repeat request sends nothing", async () => {
    const facebook = fakeFacebook();
    const request = await linkedRequest(approvedVariant);
    const deps = { store: sqlOrganicStore(db.sql), transport: facebook.transport, now: () => NOW };
    const first = await publishRepurposedVariantWith(request, deps);
    assert.equal(first.status, "published");
    assert.equal(first.status === "published" && first.externalId, "fb_video_1");
    assert.equal(facebook.posts.length, 1);
    assert.equal(await organicPostsFor(request.creativeId), 1, "the receipt is an organic post the telemetry reads");

    const repeat = await publishRepurposedVariantWith(request, deps);
    assert.equal(repeat.status, "already_published");
    assert.equal(facebook.posts.length, 1, "a repeat request does not post again");
    assert.equal(await organicPostsFor(request.creativeId), 1);
  });

  test("two requests at the same time post once", async () => {
    const facebook = fakeFacebook();
    const request = await linkedRequest(approvedVariant, { pageId: "7001", connection: { ...CONNECTION, accountId: "7001" } });
    const deps = { store: sqlOrganicStore(db.sql), transport: facebook.transport, now: () => NOW };
    const results = await Promise.all([publishRepurposedVariantWith(request, deps), publishRepurposedVariantWith(request, deps)]);
    assert.equal(facebook.posts.length, 1, "exactly one post");
    assert.ok(results.some((result) => result.status === "in_progress" || result.status === "already_published"));
  });

  test("a lost reply leaves the post uncertain: nothing is posted again without a confirmation, and a confirmed retry posts once", async () => {
    const facebook = fakeFacebook(["lose", "ok"]);
    const request = await linkedRequest(approvedVariant);
    // A different page keeps this operation separate from the success above; the variation is the same, the Page is not.
    const other = { ...request, pageId: "2030" };
    const deps = { store: sqlOrganicStore(db.sql), transport: facebook.transport, now: () => NOW };
    const lost = await publishRepurposedVariantWith(other, deps);
    assert.equal(lost.status, "uncertain");
    assert.equal(facebook.posts.length, 1);

    const blocked = await publishRepurposedVariantWith(other, deps);
    assert.equal(blocked.status, "uncertain", "an uncertain post is not sent again without a confirmation");
    assert.equal(facebook.posts.length, 1);

    const confirmed = await publishRepurposedVariantWith({ ...other, confirmRetry: true, connection: { ...CONNECTION, accountId: "2030" } }, deps);
    assert.equal(confirmed.status, "published");
    assert.equal(facebook.posts.length, 2, "the confirmed retry posts once");
  });

  test("a server error after Facebook may have posted is uncertain, not a refusal", async () => {
    const facebook = fakeFacebook(["server"]);
    const request = await linkedRequest(approvedVariant, { pageId: "3040", connection: { ...CONNECTION, accountId: "3040" } });
    const outcome = await publishRepurposedVariantWith(request, { store: sqlOrganicStore(db.sql), transport: facebook.transport, now: () => NOW });
    assert.equal(outcome.status, "uncertain");
  });

  test("a rate limit is uncertain too, because it can follow an accepted post", async () => {
    const facebook = fakeFacebook(["rate_limited"]);
    const request = await linkedRequest(approvedVariant, { pageId: "4050", connection: { ...CONNECTION, accountId: "4050" } });
    const outcome = await publishRepurposedVariantWith(request, { store: sqlOrganicStore(db.sql), transport: facebook.transport, now: () => NOW });
    assert.equal(outcome.status, "uncertain");
  });

  test("a permission failure is a definite refusal, nothing is recorded as published, and a corrected request posts once", async () => {
    const facebook = fakeFacebook(["forbidden", "ok"]);
    const request = await linkedRequest(approvedVariant, { pageId: "5060", connection: { ...CONNECTION, accountId: "5060" } });
    const deps = { store: sqlOrganicStore(db.sql), transport: facebook.transport, now: () => NOW };
    const receiptsBefore = await organicPostsFor(request.creativeId);
    const refused = await publishRepurposedVariantWith(request, deps);
    assert.equal(refused.status, "refused");
    assert.match(refused.status === "refused" ? refused.reason : "", /token/i);
    assert.equal(await organicPostsFor(request.creativeId), receiptsBefore, "a refused post records no receipt");

    const retried = await publishRepurposedVariantWith(request, deps);
    assert.equal(retried.status, "published");
    assert.equal(facebook.posts.length, 2);
  });

  test("a second Page for the same variation is a separate post, and its first attempt is not confused with the other's", async () => {
    const facebook = fakeFacebook();
    const request = await linkedRequest(approvedVariant, { pageId: "6070", connection: { ...CONNECTION, accountId: "6070" } });
    const outcome = await publishRepurposedVariantWith(request, { store: sqlOrganicStore(db.sql), transport: facebook.transport, now: () => NOW });
    assert.equal(outcome.status, "published");
    const rows = await db.sql<{ n: number }>`select count(*)::int as n from content_factory_repurpose_organic_publications where variant_id = ${request.source.variantId}`;
    assert.ok(rows[0]!.n >= 2, "one operation per Page");
  });

  test("the publish action refuses a Page that is not saved for the brand, before anything is read or sent", async () => {
    const { publishRepurposedVariantToFacebookPage } = await import("./repurpose-organic.ts");
    const outcome = await publishRepurposedVariantToFacebookPage(
      db.sql,
      ADMIN,
      { sessionId: SESSION, runId: RUN, variantKey: approvedVariant, pageId: "9999", caption: "", title: "" },
      { transport: async () => { throw new Error("nothing may be sent"); }, loadMedia: async () => null },
    );
    assert.equal(outcome.status, "blocked");
  });

  test("the publish action refuses a member, and a user of another workspace", async () => {
    const { publishRepurposedVariantToFacebookPage } = await import("./repurpose-organic.ts");
    const deps = { transport: async () => { throw new Error("nothing may be sent"); }, loadMedia: async () => null };
    await assert.rejects(publishRepurposedVariantToFacebookPage(db.sql, MEMBER, { sessionId: SESSION, runId: RUN, variantKey: approvedVariant, pageId: PAGE, caption: "", title: "" }, deps));
    await assert.rejects(publishRepurposedVariantToFacebookPage(db.sql, OUTSIDER, { sessionId: SESSION, runId: RUN, variantKey: approvedVariant, pageId: PAGE, caption: "", title: "" }, deps));
  });
});

describe("rights at the link", () => {
  test("a stored file with no rights record blocks the variation; a current record covers it; an expired record blocks it again", async () => {
    await db.sql`insert into content_factory_messages (id, organization_id, session_id, author_id, text) values ('msg_organic_rights', ${WS}, ${SESSION}, ${ADMIN}, '')`;
    await db.sql`
      insert into content_factory_attachments (id, organization_id, session_id, message_id, kind, purpose, file_name, storage_key, media_type, byte_size, sha256)
      values ('att_organic_rights', ${WS}, ${SESSION}, 'msg_organic_rights', 'file', 'reference_video', 'master.mp4', 'organic-rights-key', 'video/mp4', 100, ${"a".repeat(64)})
    `;
    try {
      const missing = await repurposedVariantSource(db.sql, ADMIN, { sessionId: SESSION, runId: RUN, variantKey: approvedVariant });
      assert.equal(missing.ok, false, "a file with no rights record is refused");
      assert.match(missing.ok ? "" : missing.reason, /No valid rights record covers master\.mp4/);

      await db.sql`
        insert into rights_records (id, organization_id, brand_id, subject, holder, permitted_use, valid_until, attachment_id, created_by)
        values ('rights_organic_ok', ${WS}, ${BRAND}, 'master', 'Fixture holder', 'organic posts', null, 'att_organic_rights', ${ADMIN})
      `;
      const covered = await repurposedVariantSource(db.sql, ADMIN, { sessionId: SESSION, runId: RUN, variantKey: approvedVariant });
      assert.equal(covered.ok, true, "a current record covers the file");
      assert.deepEqual(covered.ok ? covered.source.rightsRecordIds : [], ["rights_organic_ok"]);

      await db.sql`update rights_records set valid_until = '2020-01-01' where id = 'rights_organic_ok'`;
      const expired = await repurposedVariantSource(db.sql, ADMIN, { sessionId: SESSION, runId: RUN, variantKey: approvedVariant });
      assert.equal(expired.ok, false, "an expired record no longer covers the file");
    } finally {
      await db.sql`delete from rights_records where id = 'rights_organic_ok'`;
      await db.sql`delete from content_factory_attachments where id = 'att_organic_rights'`;
      await db.sql`delete from content_factory_messages where id = 'msg_organic_rights'`;
    }
  });
});
