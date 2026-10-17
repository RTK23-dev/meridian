// Contract v9 (Bible section 4, v9 note): the ledger entry records the provider's own id for a paid call (providerRef). An entry written
// before v9 has none and reads as null. Refusals of a bad providerRef are in invalid.test.ts; this file checks what must be accepted.

import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACTS_VERSION, ledgerEntrySchema, providerRefSchema, type ProviderRef } from "./index.ts";
import { ledgerClaudeFixture, ledgerRenderFixture } from "./fixtures/index.ts";

test("the contract set is engine-contracts@9 (the version the v9 note of Bible section 4 records)", () => {
  assert.equal(CONTRACTS_VERSION, "engine-contracts@9");
});

test("an entry written before v9 has no providerRef, and reads as null", () => {
  const { providerRef: _ignored, ...beforeV9 } = ledgerRenderFixture;
  const parsed = ledgerEntrySchema.parse(beforeV9);
  assert.equal(parsed.providerRef, null);
});

test("an entry with a providerRef, settled or held, reads back with it", () => {
  const held = ledgerEntrySchema.parse({ ...ledgerRenderFixture, actualUsd: undefined, settlement: undefined, providerRef: "gen-speech-1" });
  assert.equal(held.providerRef, "gen-speech-1");
  assert.equal(held.settlement, undefined);
  assert.equal(held.actualUsd, undefined);
  const settled = ledgerEntrySchema.parse({ ...ledgerClaudeFixture, providerRef: "gen-fixture-planner-1" });
  assert.equal(settled.providerRef, "gen-fixture-planner-1");
  assert.equal(settled.settlement, "billed");
});

test("a providerRef is a non-empty id of at most 512 characters, and its type is exported", () => {
  const ok: ProviderRef = "3f2a9c1e-7b64-4d0a-8e15-6c2b9d4f1a70";
  assert.equal(providerRefSchema.safeParse(ok).success, true);
  assert.equal(providerRefSchema.safeParse("x".repeat(512)).success, true);
  assert.equal(providerRefSchema.safeParse("").success, false);
  assert.equal(providerRefSchema.safeParse("x".repeat(513)).success, false);
  assert.equal(providerRefSchema.safeParse(42).success, false);
});
