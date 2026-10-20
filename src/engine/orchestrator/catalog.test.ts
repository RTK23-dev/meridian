import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadCatalog } from "./catalog.ts";

const recorded = JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"));

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "vendor/model",
  name: "Model",
  kind: "text",
  input_modalities: ["text"],
  output_modalities: ["text"],
  ...overrides,
});

test("the recorded snapshot loads with no dropped rows", () => {
  const catalog = loadCatalog(recorded);
  assert.deepEqual(catalog.dropped, []);
  assert.equal(catalog.byId.size, recorded.entries.length);
  assert.equal(catalog.takenAt, "2026-10-20");
});

test("the counts by kind match the recording", () => {
  const counts: Record<string, number> = {};
  for (const entry of loadCatalog(recorded).byId.values()) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  assert.deepEqual(counts, recorded.counts);
});

test("live alias entries with a leading ~ are kept", () => {
  assert.equal(loadCatalog(recorded).byId.get("~anthropic/claude-opus-latest")?.kind, "text");
});

test("a row that does not parse is dropped with its reason, not guessed", () => {
  const catalog = loadCatalog({ source: "test", takenAt: "t", entries: [row({ id: "bad id" }), row({ id: "a/b", name: "B" })] });
  assert.equal(catalog.dropped.length, 1);
  assert.equal(catalog.dropped[0]?.index, 0);
  assert.equal(catalog.byId.has("a/b"), true);
});

test("a row with an unknown kind is dropped", () => {
  const catalog = loadCatalog({ source: "test", takenAt: "t", entries: [row({ id: "a/b", kind: "audio" })] });
  assert.equal(catalog.byId.size, 0);
  assert.equal(catalog.dropped.length, 1);
});

test("a duplicate id keeps the first row and names the duplicate", () => {
  const catalog = loadCatalog({
    source: "test",
    takenAt: "t",
    entries: [row({ id: "a/b", name: "First" }), row({ id: "a/b", name: "Second", kind: "image" })],
  });
  assert.equal(catalog.byId.get("a/b")?.name, "First");
  assert.match(catalog.dropped[0]?.reason ?? "", /duplicate id a\/b/);
});

test("a snapshot without a list is refused outright: no list, no run", () => {
  assert.throws(() => loadCatalog({ takenAt: "t" }));
});
