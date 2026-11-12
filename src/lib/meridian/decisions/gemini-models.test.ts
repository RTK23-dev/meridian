// Google's model list is read live; nothing here names a model. Fixtures are shaped like the documented models.list response.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { readGeminiModelChoice, writeGeminiModelChoice } from "./gemini-engine.ts";
import { geminiVersion, parseGeminiModels, readGeminiModels } from "./gemini-models.ts";

const GENERATE = ["generateContent", "countTokens"];
const list = (...entries: Array<{ name: string; methods?: string[] }>) => ({
  models: entries.map((entry) => ({ name: `models/${entry.name}`, displayName: entry.name, description: "d", inputTokenLimit: 1000000, outputTokenLimit: 8192, supportedGenerationMethods: entry.methods ?? GENERATE })),
});

test("only text models that can generate content are offered, newest first, and the newest released one is marked latest", () => {
  const read = parseGeminiModels(list(
    { name: "gemini-2.5-flash" },
    { name: "gemini-3.0-pro-preview" },
    { name: "gemini-3.0-flash" },
    { name: "gemini-2.5-pro" },
    { name: "gemini-embedding-001", methods: ["embedContent"] },
    { name: "gemini-2.5-flash-preview-tts" },
    { name: "gemini-3.0-pro-image" },
    { name: "gemini-no-generate", methods: ["countTokens"] },
    { name: "gemma-3-27b-it" },
  ), "now");
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.deepEqual(read.models.map((model) => model.id), ["gemini-3.0-flash", "gemini-3.0-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"]);
  assert.equal(read.models[0].version?.join("."), "3.0");
  const latest = read.models.filter((model) => model.latest);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].id, "gemini-3.0-flash", "a preview is not the latest while a released model of that version exists");
  for (const id of ["gemini-embedding-001", "gemini-2.5-flash-preview-tts", "gemini-3.0-pro-image", "gemini-no-generate", "gemma-3-27b-it"]) {
    assert.ok(!read.models.some((model) => model.id === id), `${id} is not offered`);
  }
});

test("a newer Gemini appears when Google lists it: nothing is named in code", () => {
  const before = parseGeminiModels(list({ name: "gemini-2.5-pro" }), "t");
  const after = parseGeminiModels(list({ name: "gemini-2.5-pro" }, { name: "gemini-9.1-pro" }), "t");
  assert.ok(before.ok && after.ok);
  if (before.ok && after.ok) {
    assert.equal(before.models.find((m) => m.latest)?.id, "gemini-2.5-pro");
    assert.equal(after.models.find((m) => m.latest)?.id, "gemini-9.1-pro");
  }
});

test("versions are read from the name, and a name with none sorts last", () => {
  assert.deepEqual(geminiVersion("gemini-2.5-flash"), [2, 5]);
  assert.deepEqual(geminiVersion("gemini-3-pro"), [3]);
  assert.equal(geminiVersion("gemini-pro-latest"), null);
});

test("a body without a models array offers nothing and says why", () => {
  const read = parseGeminiModels({ nope: true }, "t");
  assert.equal(read.ok, false);
});

test("the list is read with the key in a header, a failed read says so, and a missing key reads nothing", async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const ok = (async (url: string | URL | Request, init?: RequestInit) => { seen.push({ url: String(url), headers: init?.headers as Record<string, string> }); return new Response(JSON.stringify(list({ name: "gemini-2.5-pro" })), { status: 200 }); }) as typeof fetch;
  const read = await readGeminiModels("AIzaKEY", ok);
  assert.ok(read.ok);
  assert.equal(seen[0].headers["x-goog-api-key"], "AIzaKEY");
  assert.ok(!seen[0].url.includes("AIzaKEY"));
  const denied = await readGeminiModels("AIzaKEY", (async () => new Response("no", { status: 403 })) as typeof fetch);
  assert.equal(denied.ok, false);
  const none = await readGeminiModels("", ok);
  assert.equal(none.ok, false);
  assert.equal(seen.length, 1, "no key, no request");
});

let db: TestDatabase;
before(async () => { db = await createTestDatabase(); await seedWorkspace(db.sql, "org_gm", "brand_gm"); });
after(async () => { await db.close(); });

test("the workspace's chosen model is stored, replaced and audited, and a workspace with none has none", async () => {
  assert.equal(await readGeminiModelChoice(db.sql, "org_gm"), null);
  await writeGeminiModelChoice(db.sql, { organizationId: "org_gm", actorId: "u1", model: "gemini-2.5-pro" });
  assert.equal(await readGeminiModelChoice(db.sql, "org_gm"), "gemini-2.5-pro");
  await writeGeminiModelChoice(db.sql, { organizationId: "org_gm", actorId: "u1", model: "gemini-3.0-flash" });
  assert.equal(await readGeminiModelChoice(db.sql, "org_gm"), "gemini-3.0-flash");
  const audit = await db.sql<{ n: number }>`select count(*)::int as n from audit_log where organization_id = 'org_gm' and action = 'decision_engine.gemini_model.update'`;
  assert.equal(audit[0]?.n, 2);
});

test("the new engine id is accepted where engines are stored", async () => {
  await db.sql`insert into decision_engine_settings (organization_id, engine_id, updated_by) values ('org_gm', 'gemini-decisions', 'u1') on conflict (organization_id) do update set engine_id = excluded.engine_id`;
  const rows = await db.sql<{ engine_id: string }>`select engine_id from decision_engine_settings where organization_id = 'org_gm'`;
  assert.equal(rows[0]?.engine_id, "gemini-decisions");
});
