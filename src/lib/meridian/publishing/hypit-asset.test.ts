import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Sql } from "../learning/store.ts";
import { publishThrough } from "../providers/boundaries.ts";
import { memoryPublishLedger, publishStoredHypitAsset, sqlPublishLedger, type StoredHypitPublishInput } from "./hypit-asset.ts";

// Test-provider publishing is restricted to the testing runtime.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

const REAL_SHA = "daaff4d5d84675a0d70f78c4fb13a60828626de2640bd1126c0780a3aec63e9c";
const REAL_JOB = "bld_20261006T070619745Z_B3ADAF5010";

const realBytes = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../../evals/hypit/bld_20261006T070619745Z_B3ADAF5010.mp4"),
);

function input(overrides: Partial<StoredHypitPublishInput> = {}): StoredHypitPublishInput {
  return {
    organizationId: "org-live",
    brandId: "brand-live",
    jevDecisionId: "dec-live",
    briefId: "brief-live",
    hypitJobId: REAL_JOB,
    hypitStatus: "succeeded",
    decision: "AUTO_APPROVE",
    reviewerDecision: "",
    decisionOrganizationId: "org-live",
    decisionBrandId: "brand-live",
    storageKey: "hypit/org-live/brand-live/652c10dba9c86c6bcc86df9b88f7bbf70f567eabec4c18c85457aa36c602d78e.mp4",
    sha256: REAL_SHA,
    mime: "video/mp4",
    byteLength: realBytes.byteLength,
    bytes: realBytes,
    ...overrides,
  };
}

test("the real Hypit MP4 is published once through the test publisher", async () => {
  assert.equal(createHash("sha256").update(realBytes).digest("hex"), REAL_SHA);
  assert.ok(Buffer.from(realBytes.subarray(0, 32)).toString("latin1").includes("ftyp"));
  const ledger = memoryPublishLedger();
  let calls = 0;
  const first = await publishStoredHypitAsset(input(), ledger, (request) => {
    calls += 1;
    assert.equal(request.artifact?.bytes, realBytes);
    return publishThrough(request);
  });
  const second = await publishStoredHypitAsset(input(), ledger, (request) => {
    calls += 1;
    return publishThrough(request);
  });
  assert.equal(first.published, true);
  assert.equal(second.published, true);
  if (!first.published || !second.published) return;
  assert.equal(calls, 1);
  assert.equal(first.receipt.externalId, second.receipt.externalId);
  assert.equal(first.receipt.sha256, REAL_SHA);
  assert.equal(first.receipt.byteLength, 10472);
  assert.equal(first.receipt.mime, "video/mp4");
  assert.equal(first.receipt.hypitJobId, REAL_JOB);
  assert.equal(first.receipt.jevDecisionId, "dec-live");
  assert.equal(first.receipt.briefId, "brief-live");
  assert.equal(first.receipt.status, "TEST_PUBLISHED");
  assert.match(first.receipt.externalId, /^test:hypit\//);
  const statements: string[] = [];
  const values: unknown[][] = [];
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...bound: unknown[]) => {
      statements.push(strings.join("?"));
      values.push(bound);
      return [];
    },
    { query: async () => [] },
  ) as Sql;
  await sqlPublishLedger(sql, "actor-live").save(first.receipt);
  assert.match(statements[0] ?? "", /provider_objects/);
  assert.match(statements[1] ?? "", /audit_log/);
  assert.equal(values[0]?.includes(REAL_JOB), true);
  assert.equal(values[0]?.includes(first.receipt.externalId), true);
  assert.match(String(values[1]?.at(-1) ?? ""), /dec-live/);
  assert.match(String(values[1]?.at(-1) ?? ""), new RegExp(REAL_SHA));
});

test("a missing Hypit artifact is not published", async () => {
  let calls = 0;
  const result = await publishStoredHypitAsset(input({ bytes: null }), memoryPublishLedger(), () => {
    calls += 1;
    return { status: "TEST_PUBLISHED", externalId: "test:should-not", mode: "test" };
  });
  assert.equal(result.published, false);
  assert.equal(calls, 0);
});

test("a failed Hypit job is not published", async () => {
  let calls = 0;
  const result = await publishStoredHypitAsset(input({ hypitStatus: "failed" }), memoryPublishLedger(), () => {
    calls += 1;
    return { status: "TEST_PUBLISHED", externalId: "test:should-not", mode: "test" };
  });
  assert.equal(result.published, false);
  assert.equal(calls, 0);
});

test("an unapproved JEV decision is not published", async () => {
  let calls = 0;
  const rejected = await publishStoredHypitAsset(input({ decision: "REJECT" }), memoryPublishLedger(), () => {
    calls += 1;
    return { status: "TEST_PUBLISHED", externalId: "test:should-not", mode: "test" };
  });
  const review = await publishStoredHypitAsset(
    input({ decision: "HUMAN_REVIEW", reviewerDecision: "" }),
    memoryPublishLedger(),
    () => {
      calls += 1;
      return { status: "TEST_PUBLISHED", externalId: "test:should-not", mode: "test" };
    },
  );
  assert.equal(rejected.published, false);
  assert.equal(review.published, false);
  assert.equal(calls, 0);
});

test("another tenant cannot publish this artifact", async () => {
  await assert.rejects(
    () => publishStoredHypitAsset(input({ decisionOrganizationId: "org-2" }), memoryPublishLedger()),
    /Tenant scope violation/,
  );
});
