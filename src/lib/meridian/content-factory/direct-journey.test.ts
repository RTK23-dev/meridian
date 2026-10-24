// The direct-creation journey from a Content Factory session through the engine (acceptance trace). A session is started with the real
// service, its request is queued in the engine's job table, and the worker's own claim runs each queued engine job through the production
// composition over a recording gateway. The recording transport answers nothing, so any provider call is refused and recorded: nothing is
// paid and no network is used. The reference clip is a real two-second file made with ffmpeg, so the local media functions read it.
// What this proves is which stage the real wiring reaches and where it stops, not that a video is produced.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { stagesNeeded } from "../../../engine/api/index.ts";
import { characterSheetFixture, personaFixture, styleKitFixture, voiceKitFixture } from "../../../engine/contracts/fixtures/index.ts";
import { createGateway } from "../../../engine/gateway/index.ts";
import { executeEngineJob } from "../../../engine/jobs/dispatch.ts";
import { writeKit } from "../../../engine/jobs/kit-store.ts";
import { notConnectedMediaLinks } from "../../../engine/jobs/media-link.ts";
import { productionVariantPorts } from "../../../engine/jobs/production-ports.ts";
import { createEngineRuntime, productionComposition } from "../../../engine/jobs/runtime.ts";
import { fakeObjects, keySource, recordedTransport } from "../../../engine/jobs/test/harness.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { claimAndRun } from "../jobs/sql-worker.ts";
import type { Sql } from "../learning/store.ts";
import type { ContentFactoryFileStore } from "./files.ts";
import { attachSource, createSession, postMessage, readRun, saveSettings, startRun, uploadFile } from "./service.ts";

const WS = "ws_trace_direct";
const BRAND = "brand_trace_direct";
const ADMIN = "user_trace_admin";
const TRACE_OPENROUTER_KEY = "sk-or-trace-not-a-key";

/** One object store for the whole trace: the file the session stores is the file analyze_reference reads (both are Meridian's store in production). */
const objects = fakeObjects();

function memoryStore(): ContentFactoryFileStore {
  return {
    ready: async () => ({ status: "ready" }),
    put: async (input) => {
      await objects.put(input);
      return { storageObjectId: null };
    },
  };
}

/** A real two-second reference clip, made with ffmpeg in a temp directory at run time. */
function referenceClipBase64(): string {
  const dir = mkdtempSync(join(tmpdir(), "trace-reference-"));
  const out = join(dir, "reference.mp4");
  try {
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=duration=2:size=360x640:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart",
      out,
    ]);
    return readFileSync(out).toString("base64");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every connection the readiness reads, reported ready. The engine's own stages then decide what else stops the run. */
function connectedReadiness() {
  const stub = { async run() { throw new Error("not run by this test"); } };
  return {
    monthBudget: { monthBudget: async () => ({ status: "known" as const, usd: 100 }) },
    credentials: { get: async () => ({ status: "ready" as const, credential: { kind: "api_key" as const, secret: "fixture-not-a-key" } }) },
    runtime: { handlers: Object.fromEntries(stagesNeeded(0).map((stage) => [stage, stub])) },
  };
}

describe("direct creation, from a Content Factory session to the engine's first connection it does not have", () => {
  let db: TestDatabase;
  let MP4 = "";

  before(async () => {
    MP4 = referenceClipBase64();
    db = await createTestDatabase();
    await seedWorkspace(db.sql, WS, BRAND);
    await db.sql`insert into "user" (id, name, email, "emailVerified") values (${ADMIN}, ${ADMIN}, ${`${ADMIN}@fixture.example`}, true)`;
    await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${ADMIN}`}, ${WS}, ${ADMIN}, 'admin')`;
    // The workspace's monthly video budget, as Settings stores it (organizations.monthly_video_budget_usd).
    await db.sql`update organizations set monthly_video_budget_usd = 50 where id = ${WS}`;
    await db.sql`
      insert into theme_pages (id, organization_id, brand_id, name, niche, platform, style_kit_id, voice_kit_id)
      values ('page_trace_1', ${WS}, ${BRAND}, 'Kitchen hacks', 'kitchen', 'instagram', 'sk_fixture', 'voice_fixture')
    `;
    // The kits the page names, as the kit store holds them (the fixtures the engine's end-to-end test writes).
    await writeKit(db.sql, { organizationId: WS, kind: "style", body: styleKitFixture });
    await writeKit(db.sql, { organizationId: WS, kind: "persona", body: personaFixture });
    await writeKit(db.sql, { organizationId: WS, kind: "character", body: characterSheetFixture });
    await writeKit(db.sql, { organizationId: WS, kind: "voice", body: voiceKitFixture });
  });

  after(async () => {
    await db.close();
  });

  async function readySession(): Promise<string> {
    const session = await createSession(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, title: "Trace: blender reel" });
    const intro = await postMessage(db.sql, ADMIN, { sessionId: session.id, text: "A reel for our blender, with the pacing of the saved reel.", beatRole: null });
    await uploadFile(db.sql, ADMIN, { sessionId: session.id, messageId: intro.messageId, fileName: "reel.mp4", purpose: "reference_video", base64: MP4 }, { files: memoryStore() });
    await attachSource(db.sql, ADMIN, { sessionId: session.id, messageId: intro.messageId, brandId: BRAND, page: "page", recordId: "page_trace_1" });
    await saveSettings(db.sql, ADMIN, { sessionId: session.id, budgetUsd: 4, maxSeconds: 30, language: "en", priority: "normal", keepGenes: [] });
    return session.id;
  }

  test("with no key saved, the production readiness refuses the start and names what is not connected; nothing is queued", async () => {
    const sessionId = await readySession();
    const outcome = await startRun(db.sql, ADMIN, { sessionId });
    assert.equal(outcome.status, "refused");
    assert.ok(outcome.status === "refused" && outcome.notConnected.some((reason) => reason.startsWith("OpenRouter:")));
    assert.ok(outcome.status === "refused" && outcome.notConnected.some((reason) => reason.startsWith("Render:")));
    const queued = await db.sql<{ n: number }>`select count(*)::int as n from jobs where organization_id = ${WS}`;
    assert.equal(queued[0]?.n ?? 0, 0, "a refused start queues no engine job");
  });

  test("a started session queues its engine request; the worker runs intake, and the request stops at speech-to-text, which is not connected, with no provider call", async () => {
    const sessionId = await readySession();
    const started = await startRun(db.sql, ADMIN, { sessionId }, { readiness: connectedReadiness() as never });
    assert.equal(started.status, "started");

    // The production composition over a recording gateway with only the OpenRouter key: every other connection is not connected.
    const transport = recordedTransport({});
    const gateway = createGateway({ transport: transport.transport, credentials: keySource({ openrouter: TRACE_OPENROUTER_KEY }) });
    const composition = productionComposition(db.sql as unknown as Sql, {
      gateway,
      mediaLinks: notConnectedMediaLinks("this trace has no media link signer"),
      objects,
      referenceStore: { get: (organizationId, brandId, key) => objects.get(organizationId, brandId, key), release: async () => undefined },
      mediaFunctionsMode: "in_process",
      mediaFunctionsBaseUrl: null,
    });
    const runtime = createEngineRuntime({
      ...composition,
      variants: productionVariantPorts({
        sql: db.sql as unknown as Sql,
        gateway: composition.gateway,
        speech: composition.speech,
        voice: typeof composition.voice === "function" ? composition.voice : undefined,
        roles: () => ({}) as never,
        workspaceBudget: composition.workspaceBudget,
        loadStyleKit: async () => undefined,
        now: () => new Date().toISOString(),
      }),
    });

    // Drain the queue the way the worker does: claim, run, and record the outcome.
    for (let step = 0; step < 12; step += 1) {
      const next = await db.sql<{ id: string }>`
        select id from jobs where organization_id = ${WS} and job_type like 'engine.%' and status in ('queued', 'retry')
        order by created_at asc, id asc limit 1
      `;
      if (!next[0]) break;
      await claimAndRun(db.sql, next[0].id, (sql, job) => executeEngineJob(sql, job, runtime));
    }

    const jobs = await db.sql<{ job_type: string; status: string; last_error: string }>`
      select job_type, status, last_error from jobs where organization_id = ${WS} order by created_at asc, id asc
    `;
    assert.deepEqual(
      jobs.map((job) => [job.job_type, job.status]),
      [["engine.intake", "succeeded"], ["engine.analyze_reference", "dead"]],
      "intake passes and queues the reference analysis, which cannot finish without speech-to-text",
    );
    assert.match(jobs[1]?.last_error ?? "", /speech-to-text|deepgram/i, "the stop names the speech connection");
    assert.deepEqual(transport.requests, [], "nothing is sent to a provider: the speech connection is refused before any call");

    const view = await readRun(db.sql, ADMIN, { sessionId }, { readiness: connectedReadiness() as never });
    assert.equal(view.stage, "started");
    assert.ok(view.stage === "started" && /speech-to-text|Deepgram/i.test(view.feed.headline), "the run view names the stop, not a delivered video");
  });
});
