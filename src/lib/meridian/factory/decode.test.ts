import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { buildFixtureClip, solidFrame } from "../video/inspect.ts";
import {
  CREATIVE_DNA_V2,
  emptyCreativeDna,
  decodeOk,
} from "./creative-dna.ts";
import {
  classifyTextRole,
  decodeVideoDna,
  detectScenes,
  type SceneVisionLabels,
} from "./decode.ts";
import type { Sql } from "../learning/store.ts";
import type { ResearchSegment } from "../research/schema.ts";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function makeTestDb(): Promise<Sql> {
  const db = new PGlite({ extensions: { vector } });
  await db.waitReady;
  const dir = join(process.cwd(), "migrations");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  await db.exec("create table if not exists _migrations (name text primary key)");
  for (const name of names) {
    const text = await readFile(join(dir, name), "utf8");
    await db.exec(text);
  }
  const sql = (async <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? "";
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1] ?? ""}`;
    const result = await db.query<T>(text, values);
    return result.rows;
  }) as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await db.query<T>(text, params)).rows;
  return sql;
}

test("Creative DNA v2: scene detection extracts keyframes per scene and calculates cuts per second", async () => {
  const frame1 = solidFrame(80, 60, [255, 0, 0]); // Red scene
  const frame2 = solidFrame(80, 60, [0, 255, 0]); // Green scene
  const frame3 = solidFrame(80, 60, [0, 0, 255]); // Blue scene

  const videoBytes = buildFixtureClip({
    durationMs: 9000,
    width: 80,
    height: 60,
    frames: [frame1, frame2, frame3],
  });

  const { scenes, cutsPerSecond, totalDurationMs } = await detectScenes(videoBytes, { durationMs: 9000 });
  assert.equal(scenes.length, 3);
  assert.equal(totalDurationMs, 9000);
  assert.equal(scenes[0]?.startMs, 0);
  assert.equal(scenes[0]?.endMs, 3000);
  assert.ok(scenes[0]?.keyframeBytes);
  assert.equal(scenes[1]?.startMs, 3000);
  assert.equal(scenes[1]?.endMs, 6000);
  assert.equal(scenes[2]?.startMs, 6000);
  assert.equal(scenes[2]?.endMs, 9000);
  assert.ok(cutsPerSecond > 0);
});

test("Creative DNA v2: vision-model labels each scene with confidence and frame source", async () => {
  const frame1 = solidFrame(80, 60, [200, 10, 10]);
  const frame2 = solidFrame(80, 60, [10, 200, 10]);
  const videoBytes = buildFixtureClip({
    durationMs: 6000,
    width: 80,
    height: 60,
    frames: [frame1, frame2],
  });

  const mockVision: Record<number, SceneVisionLabels> = {
    0: {
      shotType: "close_up",
      presenter: "creator_selfie",
      productOnScreen: false,
      setting: "bathroom",
      motion: "handheld",
      overlay: "none",
      confidence: 0.88,
    },
    1: {
      shotType: "medium_shot",
      presenter: "hands_only",
      productOnScreen: true,
      setting: "bathroom",
      motion: "static",
      overlay: "before_after",
      confidence: 0.92,
    },
  };

  const dna = await decodeVideoDna({
    adId: "ad-fixture-1",
    videoBytes,
    durationMs: 6000,
    visionLabeller: async (_bytes, index) => mockVision[index] ?? null,
  });

  assert.equal(dna.schema, CREATIVE_DNA_V2);
  assert.ok(decodeOk(dna));
  assert.equal(dna.scenes.length, 2);

  // Scene 0 assertions
  const s0 = dna.scenes[0]!;
  assert.equal(s0.shotType.value, "close_up");
  assert.equal(s0.shotType.confidence, 0.88);
  assert.equal(s0.shotType.source.kind, "frame");
  assert.equal(s0.presenter.value, "creator_selfie");
  assert.equal(s0.productOnScreen.value, false);

  // Scene 1 assertions
  const s1 = dna.scenes[1]!;
  assert.equal(s1.productOnScreen.value, true);
  assert.equal(s1.overlay.value, "before_after");
  assert.equal(s1.overlay.confidence, 0.92);
  assert.equal(s1.overlay.source.kind, "frame");
});

test("Creative DNA v2: OCR extracts on-screen text with timing and role", async () => {
  const frame1 = solidFrame(80, 60, [100, 100, 100]);
  const frame2 = solidFrame(80, 60, [150, 150, 150]);
  const videoBytes = buildFixtureClip({
    durationMs: 6000,
    width: 80,
    height: 60,
    frames: [frame1, frame2],
  });

  const dna = await decodeVideoDna({
    adId: "ad-ocr-1",
    videoBytes,
    durationMs: 6000,
    visionLabeller: async (_bytes, index) => ({
      shotType: "close_up",
      presenter: "creator",
      productOnScreen: true,
      setting: "studio",
      motion: "static",
      overlay: "text_overlay",
      confidence: 0.85,
      onScreenText:
        index === 0
          ? [{ text: "Stop using harsh cleansers!" }]
          : [{ text: "Get 20% off today - Shop Now" }],
    }),
  });

  assert.equal(dna.onScreenText.length, 2);
  assert.equal(dna.onScreenText[0]?.role, "hook_line");
  assert.equal(dna.onScreenText[0]?.text, "Stop using harsh cleansers!");
  assert.equal(dna.onScreenText[0]?.source?.kind, "frame");

  // Second text classified as CTA or Price
  assert.ok(dna.onScreenText[1]?.role === "cta" || dna.onScreenText[1]?.role === "price");
  assert.equal(dna.onScreenText[1]?.text, "Get 20% off today - Shop Now");
});

test("Creative DNA v2: classifyTextRole correctly tags marketing roles", () => {
  assert.equal(classifyTextRole("Wait, don't scroll", 1000), "hook_line");
  assert.equal(classifyTextRole("Shop Now while supplies last", 5000), "cta");
  assert.equal(classifyTextRole("Only $29 with free shipping", 4000), "price");
  assert.equal(classifyTextRole("Noticeable results in 7 days", 4500), "benefit");
  assert.equal(classifyTextRole("Natural ingredients", 4500), "other");
});

test("Creative DNA v2: WhisperX segments align to scenes and construct beat sequence", async () => {
  const frame1 = solidFrame(80, 60, [50, 50, 50]);
  const frame2 = solidFrame(80, 60, [70, 70, 70]);
  const frame3 = solidFrame(80, 60, [90, 90, 90]);
  const videoBytes = buildFixtureClip({
    durationMs: 9000,
    width: 80,
    height: 60,
    frames: [frame1, frame2, frame3],
  });

  const segments: ResearchSegment[] = [
    { id: "t1", text: "Stop scrolling if your skin feels dry.", startMs: 200, endMs: 2800, role: "hook", confidence: 0.9 },
    { id: "t2", text: "Here are the proven clinical results.", startMs: 3500, endMs: 5800, role: "proof", confidence: 0.85 },
    { id: "t3", text: "Tap the link below to get yours now.", startMs: 6500, endMs: 8800, role: "cta", confidence: 0.9 },
  ];

  const dna = await decodeVideoDna({
    adId: "ad-whisper-1",
    videoBytes,
    durationMs: 9000,
    transcript: "Stop scrolling if your skin feels dry. Here are the proven clinical results. Tap the link below to get yours now.",
    segments,
    visionLabeller: async (_b, index) => ({
      shotType: index === 0 ? "close_up" : "medium_shot",
      presenter: "creator",
      productOnScreen: index > 0,
      setting: "bathroom",
      motion: "handheld",
      overlay: index === 1 ? "before_after" : "none",
      confidence: 0.9,
    }),
  });

  // Scenes have aligned transcripts
  assert.equal(dna.scenes[0]?.transcript, "Stop scrolling if your skin feels dry.");
  assert.equal(dna.scenes[1]?.transcript, "Here are the proven clinical results.");
  assert.equal(dna.scenes[2]?.transcript, "Tap the link below to get yours now.");

  // Beats sequence includes hook, proof, and cta
  assert.ok(dna.beats.some((b) => b.role === "hook"));
  assert.ok(dna.beats.some((b) => b.role === "proof"));
  assert.ok(dna.beats.some((b) => b.role === "cta"));
  assert.equal(dna.voice.value, "spoken_voiceover");
  assert.equal(dna.voice.source.kind, "transcript");
});

test("Creative DNA v2: missing evidence stays missing and is never guessed", async () => {
  // Video with no frames, no speech, no vision model
  const emptyVideo = new Uint8Array(20);
  const dna = await decodeVideoDna({
    adId: "ad-empty-1",
    videoBytes: emptyVideo,
    durationMs: 5000,
  });

  assert.equal(dna.hook.text.confidence, 0);
  assert.equal(dna.hook.text.source.kind, "missing");
  assert.equal(dna.hook.visual.confidence, 0);
  assert.equal(dna.hook.visual.source.kind, "missing");
  assert.equal(dna.voice.confidence, 0);
  assert.equal(dna.voice.source.kind, "missing");
  assert.equal(dna.scenes[0]?.shotType.confidence, 0);
  assert.equal(dna.scenes[0]?.shotType.source.kind, "missing");
  assert.equal(dna.scenes[0]?.productOnScreen.value, false);
  assert.equal(dna.scenes[0]?.productOnScreen.confidence, 0);
  assert.equal(dna.onScreenText.length, 0);
});

test("Creative DNA v2: generates multimodal embedding and stores in pgvector column", async () => {
  const sql = await makeTestDb();
  const org = "org-dna-test";
  const brand = "brand-dna-test";
  await sql`insert into organizations (id, name, slug, created_by) values (${org}, 'Org', 'org-dna', 'user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brand}, ${org}, 'Brand', 'user')`;

  const frame1 = solidFrame(80, 60, [10, 10, 200]);
  const videoBytes = buildFixtureClip({
    durationMs: 5000,
    width: 80,
    height: 60,
    frames: [frame1],
  });

  const dummyEmbedding = new Array(384).fill(0).map((_, i) => Math.sin(i));
  const dna = await decodeVideoDna({
    adId: "ad-vector-1",
    videoBytes,
    durationMs: 5000,
    transcript: "Why did no one tell me about this oil before?",
    embedder: async () => dummyEmbedding,
    visionLabeller: async () => ({
      shotType: "close_up",
      presenter: "creator",
      productOnScreen: true,
      setting: "bedroom",
      motion: "pan",
      overlay: "none",
      confidence: 0.85,
    }),
  });

  assert.ok(dna.embedding);
  assert.equal(dna.embedding.length, 384);

  const id = `dna:${brand}:ad-vector-1`;
  const embSql = `[${dna.embedding.join(",")}]`;
  await sql`
    insert into creative_dna (id, organization_id, brand_id, research_ad_id, schema_version, record, embedding)
    values (${id}, ${org}, ${brand}, 'ad-vector-1', ${CREATIVE_DNA_V2}, ${JSON.stringify(dna)}, ${embSql})
  `;

  const stored = await sql<{ id: string; schema_version: string; has_emb: boolean }>`
    select id, schema_version, (embedding is not null) as has_emb
    from creative_dna
    where id = ${id}
  `;

  assert.equal(stored[0]?.id, id);
  assert.equal(stored[0]?.schema_version, CREATIVE_DNA_V2);
  assert.equal(stored[0]?.has_emb, true);

  // Test cosine distance query with pgvector
  const searchResults = await sql<{ id: string; dist: number }>`
    select id, (embedding <=> ${embSql}::vector) as dist
    from creative_dna
    where organization_id = ${org}
    order by embedding <=> ${embSql}::vector
    limit 1
  `;
  assert.equal(searchResults[0]?.id, id);
  assert.ok(searchResults[0]?.dist !== undefined && searchResults[0].dist < 0.0001);
});
