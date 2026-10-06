import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Transport } from "../providers/http.ts";
import type { Sql } from "../learning/store.ts";
import { buildFixtureClip } from "../video/inspect.ts";
import { buildHypitJob, type HypitHandoffInput } from "./contract.ts";
import { handoffToHypit, memoryHypitLedger, type HypitJobRecord } from "./handoff.ts";
import { storeHypitArtifact } from "./store.ts";

function decision(overrides: Partial<HypitHandoffInput["decision"]> = {}): HypitHandoffInput["decision"] {
  return {
    id: "dec-1",
    organizationId: "org-1",
    brandId: "brand-1",
    questionId: "brief_gate",
    policyVersion: "code:brief_gate.v1",
    decision: "AUTO_APPROVE",
    reviewerDecision: "",
    reasons: ["The stored evidence supports this angle."],
    evidence: [{ id: "ev-1", source: "market", summary: "Competitors do not show the lather." }],
    ...overrides,
  };
}

function input(overrides: Partial<HypitHandoffInput> = {}): HypitHandoffInput {
  return {
    organizationId: "org-1",
    brandId: "brand-1",
    product: "North bar",
    objective: "Show the lather in the first second.",
    angle: "demonstration",
    visualDirection: "Close product, no extra promise.",
    tone: "quiet",
    cta: "See the bar",
    format: "short_ugc",
    aspectRatio: "9:16",
    durationSeconds: 6,
    requiredClaims: ["lathers"],
    prohibitedClaims: ["cures"],
    brandAssets: [{ id: "logo-1", role: "logo" }],
    briefId: "brief-1",
    decision: decision(),
    ...overrides,
  };
}

function clipBase64(): string {
  return Buffer.from(buildFixtureClip({ durationMs: 2500, width: 64, height: 64, frames: [] })).toString("base64");
}

function scripted(handler: (url: string, body: string | undefined) => { status: number; body: string }): Transport & { calls: number } {
  const state = { calls: 0 };
  const transport = (async (request: { url: string; body?: string }) => {
    state.calls += 1;
    return { ...handler(request.url, request.body), headers: {} };
  }) as Transport;
  return Object.assign(transport, {
    get calls() {
      return state.calls;
    },
  });
}

test("an approved JEV decision becomes one Hypit job with lineage", () => {
  const built = buildHypitJob(input());
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.contract.schema, "meridian.hypit.job.v1");
  assert.equal(built.contract.product, "North bar");
  assert.equal(built.contract.angle, "demonstration");
  assert.deepEqual(built.contract.requiredClaims, ["lathers"]);
  assert.deepEqual(built.contract.prohibitedClaims, ["cures"]);
  assert.equal(built.contract.lineage.jevDecisionId, "dec-1");
  assert.equal(built.contract.lineage.briefId, "brief-1");
  assert.equal(built.contract.evidence[0]?.id, "ev-1");
  assert.equal(built.contract.durationSeconds, 6);
  assert.equal(built.contract.brandAssets[0]?.role, "logo");
});

test("a brief missing required fields is rejected before any provider call", () => {
  const built = buildHypitJob(input({ product: "  ", cta: "" }));
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.match(built.error, /product/);
  assert.match(built.error, /cta/);
});

test("a JEV rejection does not become a Hypit job", () => {
  const built = buildHypitJob(input({ decision: decision({ decision: "REJECT" }) }));
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.match(built.error, /rejected/);
});

test("human review without approval does not become a Hypit job", () => {
  const built = buildHypitJob(input({ decision: decision({ decision: "HUMAN_REVIEW", reviewerDecision: "" }) }));
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.match(built.error, /not approved/);
});

test("another tenant's decision cannot be handed to Hypit", () => {
  assert.throws(
    () => buildHypitJob(input({ decision: decision({ organizationId: "org-2" }) })),
    /Tenant scope violation/,
  );
});

test("an unconfigured Hypit runtime is not connected and creates no video", async () => {
  const transport = scripted(() => ({ status: 200, body: "{}" }));
  const result = await handoffToHypit(input(), {
    env: { baseUrl: "" },
    transport,
    ledger: memoryHypitLedger(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.job.status, "not_connected");
  assert.equal(result.job.code, "HYPIT_NOT_CONNECTED");
  assert.equal(result.job.artifact, null);
  assert.equal(result.artifactBytes, null);
  assert.equal(transport.calls, 0);
  assert.equal(result.job.contract.lineage.jevDecisionId, "dec-1");
});

test("a Hypit failure stays a failed job", async () => {
  const transport = scripted(() => ({ status: 503, body: "down" }));
  const result = await handoffToHypit(input(), {
    env: { baseUrl: "http://hypit.internal" },
    transport,
    ledger: memoryHypitLedger(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.job.status, "failed");
  assert.equal(result.job.code, "HYPIT_FAILED");
  assert.equal(result.job.artifact, null);
});

test("a malformed Hypit response is a failure", async () => {
  const transport = scripted(() => ({ status: 200, body: "{\"status\":\"done\"}" }));
  const result = await handoffToHypit(input(), {
    env: { baseUrl: "http://hypit.internal" },
    transport,
    ledger: memoryHypitLedger(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.job.code, "HYPIT_MALFORMED");
  assert.equal(result.job.artifact, null);
});

test("completion without video bytes is not success", async () => {
  const transport = scripted((url) => {
    if (url.endsWith("/v1/jobs")) return { status: 200, body: JSON.stringify({ providerJobId: "h1", status: "succeeded" }) };
    if (url.endsWith("/artifact")) return { status: 200, body: JSON.stringify({ mime: "video/mp4", base64: "" }) };
    return { status: 200, body: JSON.stringify({ providerJobId: "h1", status: "succeeded" }) };
  });
  const result = await handoffToHypit(input(), {
    env: { baseUrl: "http://hypit.internal" },
    transport,
    ledger: memoryHypitLedger(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.job.status, "failed");
  assert.equal(result.job.code, "HYPIT_MISSING_ASSET");
  assert.equal(result.artifactBytes, null);
});

test("a real Hypit artifact is returned and can be stored with the JEV decision", async () => {
  const encoded = clipBase64();
  const transport = scripted((url) => {
    if (url.endsWith("/artifact")) {
      return { status: 200, body: JSON.stringify({ mime: "video/mp4", base64: encoded, durationMs: 2500, width: 64, height: 64 }) };
    }
    return { status: 200, body: JSON.stringify({ providerJobId: "h1", status: "succeeded" }) };
  });
  const stored: { key: string; bytes: Uint8Array }[] = [];
  const result = await handoffToHypit(input(), {
    env: { baseUrl: "http://hypit.internal" },
    transport,
    ledger: memoryHypitLedger(),
    onArtifact: async (artifact) => {
      stored.push({ key: artifact.storageKey, bytes: artifact.bytes });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.job.status, "succeeded");
  assert.equal(result.job.provider, "hypit");
  assert.equal(result.job.contract.lineage.jevDecisionId, "dec-1");
  assert.equal(result.job.contract.lineage.briefId, "brief-1");
  assert.ok(result.artifactBytes && result.artifactBytes.byteLength > 16);
  assert.equal(result.job.artifact?.sha256, createHash("sha256").update(result.artifactBytes ?? new Uint8Array()).digest("hex"));
  assert.equal(stored.length, 1);
  assert.match(stored[0]?.key ?? "", /dec-1|brief-1|hypit/);
  const statements: string[] = [];
  const sql = Object.assign(
    async (strings: TemplateStringsArray) => {
      statements.push(strings.join("?"));
      return [];
    },
    { query: async () => [] },
  ) as Sql;
  const saved = await storeHypitArtifact(sql, result.job, result.artifactBytes ?? new Uint8Array());
  assert.equal(saved.byteSize, result.artifactBytes?.byteLength);
  assert.match(statements[0] ?? "", /asset_blobs/);
});

test("an approved human review can be handed to Hypit", () => {
  const built = buildHypitJob(input({ decision: decision({ decision: "HUMAN_REVIEW", reviewerDecision: "approved" }) }));
  assert.equal(built.ok, true);
});

test("a queued Hypit job is polled before the artifact is collected", async () => {
  const encoded = clipBase64();
  const seen: string[] = [];
  const transport = scripted((url) => {
    seen.push(url);
    if (url.endsWith("/v1/jobs")) return { status: 200, body: JSON.stringify({ providerJobId: "h1", status: "queued" }) };
    if (url.endsWith("/artifact")) {
      return { status: 200, body: JSON.stringify({ mime: "video/mp4", base64: encoded, durationMs: 2500, width: 64, height: 64 }) };
    }
    return { status: 200, body: JSON.stringify({ providerJobId: "h1", status: "succeeded" }) };
  });
  const result = await handoffToHypit(input({ briefId: "brief-poll" }), {
    env: { baseUrl: "http://hypit.internal" },
    transport,
    ledger: memoryHypitLedger(),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    seen.map((url) => url.split("/").slice(-2).join("/")),
    ["v1/jobs", "jobs/h1", "h1/artifact"],
  );
  assert.equal(result.job.contract.lineage.briefId, "brief-poll");
});

test("retrying the same decision does not create a second Meridian job", async () => {
  const ledger = memoryHypitLedger();
  const transport = scripted((url) => {
    if (url.endsWith("/v1/jobs")) return { status: 200, body: JSON.stringify({ providerJobId: "h1", status: "queued" }) };
    return { status: 200, body: JSON.stringify({ providerJobId: "h1", status: "running" }) };
  });
  const first = await handoffToHypit(input(), { env: { baseUrl: "http://hypit.internal" }, transport, ledger });
  const calls = transport.calls;
  const second = await handoffToHypit(input(), { env: { baseUrl: "http://hypit.internal" }, transport, ledger });
  assert.equal(second.job.meridianJobId, first.job.meridianJobId);
  assert.equal(transport.calls, calls);
  const rows: HypitJobRecord[] = [];
  const again = await ledger.find("org-1", "dec-1", "brief-1");
  if (again) rows.push(again);
  assert.equal(rows.length, 1);
});
