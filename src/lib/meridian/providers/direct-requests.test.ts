// Every place Meridian's code makes an outbound request, classified. Engine code makes its provider requests only through the gateway
// (src/engine/gateway). The lib code makes its own, through a direct fetch or the shared request helper (providers/http.ts), and those
// requests are not held by the engine gateway. This test is the inventory:
//
// - A new file that makes a request fails until it is classified here.
// - An entry whose file no longer makes a request fails, so the inventory cannot go stale.
// - A paid or side-effecting request must name the guard that governs it, and a guard must point at a test that exists.
// - A paid or side-effecting request with no guard is BLOCKED. The BLOCKED list is asserted exactly, so a path can leave it only by a
//   change that is reviewed here, and a path cannot join it silently.
//
// The inventory is a statement of what the code does today. It does not say that an unguarded path is safe.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();

/** Kinds that cost money or change something outside Meridian. Every entry of these kinds needs a guard or a BLOCKED reason. */
const COSTLY_OR_EXTERNAL = new Set(["paid", "side_effect"]);

type Entry = {
  kind: "transport" | "transport_helper" | "paid" | "side_effect" | "read" | "probe" | "auth" | "internal" | "fixture" | "types";
  /** "gateway" and "ledger" are the engine's guards; "guarded" names a test that proves a lib-level guard; "none" means no guard here. */
  governed: "gateway" | "ledger" | "guarded" | "none" | "n/a";
  /** For "guarded": the test file that proves the guard. It must exist. */
  evidence?: string;
  note: string;
};

const INVENTORY: Record<string, Entry> = {
  "src/engine/gateway/transport.ts": { kind: "transport", governed: "gateway", note: "The engine's one transport. Keys come from the resolver." },
  "src/lib/meridian/providers/http.ts": { kind: "transport_helper", governed: "n/a", note: "The shared request helper for lib code. Its callers are listed below." },

  // Decisions and JEV
  "src/lib/meridian/decisions/decision-catalog.ts": { kind: "read", governed: "n/a", note: "OpenRouter's public model catalogue, read without a key." },
  "src/lib/meridian/decisions/openai-engine.ts": { kind: "paid", governed: "none", note: "OpenAI Decisions. A call is not held in the ledger." },
  "src/lib/meridian/decisions/openrouter-engine.ts": {
    kind: "paid",
    governed: "ledger",
    note: "OpenRouter Decisions. Each call is held in the ledger before it is sent and settled once.",
  },
  "src/lib/meridian/jev/router.ts": { kind: "paid", governed: "none", note: "TypeSafe JEV decisions, the default JEV backend. Not held in the ledger." },

  // Generation through providers outside the gateway
  "src/lib/meridian/perception/multimodal.ts": { kind: "paid", governed: "none", note: "Gemini perception calls. Not held in the ledger." },
  "src/lib/meridian/production/providers/higgsfield.ts": { kind: "paid", governed: "none", note: "Higgsfield video generation. Not held in the ledger." },
  "src/lib/meridian/production/providers/omni.ts": { kind: "paid", governed: "none", note: "Gemini omni generation. Not held in the ledger." },
  "src/lib/meridian/providers/nano-banana.server.ts": { kind: "paid", governed: "none", note: "Gemini image generation. Not held in the ledger." },
  "src/lib/meridian/embeddings/external.ts": { kind: "paid", governed: "none", note: "A paid embeddings API. Not held in the ledger." },

  // Connection tests and probes that a person starts
  "src/lib/meridian/settings/provider-config.ts": { kind: "probe", governed: "n/a", note: "An explicit connection test a person starts. The provider may bill it." },
  "src/lib/meridian/providers/connect.ts": { kind: "probe", governed: "n/a", note: "Connection checks for a saved credential." },
  "src/lib/meridian/providers/live.ts": { kind: "probe", governed: "none", note: "Live status probes for providers. Not held in the ledger." },

  // Reads of public or account data
  "src/lib/meridian/sources/live-api.ts": { kind: "read", governed: "n/a", note: "Source reads through public APIs." },
  "src/lib/meridian/sources/scraper/social-scraper.ts": { kind: "read", governed: "n/a", note: "Public pages, read for source collection." },
  "src/lib/meridian/research/worker.ts": { kind: "read", governed: "n/a", note: "Meta Ad Library reads. The analysis that follows goes through the gateway." },
  "src/lib/meridian/factory/gather.ts": { kind: "read", governed: "n/a", note: "Source gathering for the Factory." },
  "src/lib/meridian/measurement/pull.ts": { kind: "read", governed: "n/a", note: "Reads of published post metrics." },
  "src/lib/meridian/performance/job.ts": { kind: "read", governed: "n/a", note: "Reads of performance data for a job." },
  "src/lib/meridian/distribution/metric-reads.ts": { kind: "read", governed: "n/a", note: "Reads of platform metrics." },
  "src/lib/meridian/distribution/trial-check.ts": { kind: "read", governed: "n/a", note: "Reads that check a platform trial." },
  "src/lib/meridian/providers/meta-research.ts": { kind: "read", governed: "n/a", note: "Meta research reads." },
  "src/lib/meridian/discovery/cyclone-scout-adapter.ts": { kind: "read", governed: "n/a", note: "Reads through the Cyclone observation gateway." },

  // Paid or external changes, guarded by a lib-level guard that a test proves
  "src/lib/meridian/content-factory/repurpose-paused-ad.ts": {
    kind: "side_effect",
    governed: "guarded",
    evidence: "src/lib/meridian/content-factory/repurpose-paused-ad.test.ts",
    note: "Creates paid ads paused, with receipts and idempotent recovery.",
  },
  "src/lib/meridian/providers/meta-paused-ad.ts": {
    kind: "side_effect",
    governed: "guarded",
    evidence: "src/lib/meridian/providers/meta-paused-ad.test.ts",
    note: "The paused-ad creation and recovery state machine.",
  },
  "src/lib/meridian/content-factory/repurpose-organic.ts": {
    kind: "side_effect",
    governed: "guarded",
    evidence: "src/lib/meridian/content-factory/repurpose-organic.test.ts",
    note: "An explicit organic publish, with receipts.",
  },

  // Side effects with no guard in this code. They are BLOCKED below.
  "src/lib/meridian/providers/publish-action.ts": { kind: "side_effect", governed: "none", note: "Publishes paused objects to a provider. Keys are stored, but no test exercises this function." },
  "src/lib/meridian/storage/drive.ts": { kind: "side_effect", governed: "none", note: "Writes files to a workspace's Google Drive. A retry can create a duplicate file." },
  "src/lib/meridian/storage/drive-resumable.ts": { kind: "side_effect", governed: "none", note: "Resumable Drive uploads." },
  "src/lib/meridian/alerts/deliver.ts": { kind: "side_effect", governed: "none", note: "Sends alert webhooks." },
  "src/lib/meridian/notifications/email.ts": { kind: "side_effect", governed: "none", note: "Sends email." },
  "src/lib/meridian/jobs/execute.ts": { kind: "side_effect", governed: "none", note: "Sends the request a job carries. The job decides the request." },
  "src/lib/meridian/hypit/client.ts": { kind: "side_effect", governed: "none", note: "The Hypit bridge client." },
  "src/lib/meridian/studio/hypit-run.ts": { kind: "side_effect", governed: "none", note: "Starts a Hypit run." },
  "src/lib/meridian/distribution/facebook.ts": { kind: "side_effect", governed: "none", note: "Facebook publishing. Receipts are written; no idempotency key is sent." },
  "src/lib/meridian/distribution/instagram.ts": { kind: "side_effect", governed: "none", note: "Instagram publishing. Receipts are written; no idempotency key is sent." },
  "src/lib/meridian/distribution/tiktok.ts": { kind: "side_effect", governed: "none", note: "TikTok publishing. Receipts are written; no idempotency key is sent." },
  "src/lib/meridian/distribution/youtube.ts": { kind: "side_effect", governed: "none", note: "YouTube publishing. Receipts are written; no idempotency key is sent." },
  "src/lib/meridian/providers/meta.ts": { kind: "side_effect", governed: "none", note: "Meta ad calls. The paused-ad guard is in meta-paused-ad.ts; this path is not verified idempotent." },
  "src/lib/meridian/providers/google-ads.ts": { kind: "side_effect", governed: "none", note: "Google Ads calls, including writes." },
  "src/lib/meridian/providers/tiktok.ts": { kind: "side_effect", governed: "none", note: "TikTok calls, including writes." },
  "src/lib/meridian/content-factory/repurpose-upload-service.ts": { kind: "side_effect", governed: "none", note: "The upload service's own request. Not verified idempotent." },

  // Auth and session, and internal services
  "src/routes/api/oauth/callback.ts": { kind: "auth", governed: "n/a", note: "The OAuth callback route." },
  "src/lib/meridian/storage/drive-connection-actions.ts": { kind: "auth", governed: "n/a", note: "Connects a workspace's Drive account." },
  "src/lib/meridian/storage/google-auth.ts": { kind: "auth", governed: "n/a", note: "Google token exchange." },
  "src/lib/meridian/oauth/flow.server.ts": { kind: "auth", governed: "n/a", note: "OAuth code exchange." },
  "src/lib/meridian/oauth/refresh.ts": { kind: "auth", governed: "n/a", note: "OAuth token refresh." },
  "src/routes/api/drive/callback.ts": { kind: "auth", governed: "n/a", note: "The Drive OAuth callback." },
  "src/lib/meridian/sources/sidecar.server.ts": { kind: "internal", governed: "n/a", note: "The sourcing sidecar on this deployment." },

  // Engine code. Its requests go through the gateway: the transport is injected, and production wires it from gateway.transportFor.
  "src/engine/gateway/gateway.ts": { kind: "transport", governed: "gateway", note: "The gateway. It sends through the transport and applies the credentials." },
  "src/engine/gateway/text.ts": { kind: "transport", governed: "gateway", note: "Text calls through the gateway's transport." },
  "src/engine/gateway/download.ts": { kind: "transport", governed: "gateway", note: "Downloads through the gateway's transport." },
  "src/engine/media/wire-client.ts": { kind: "transport", governed: "gateway", note: "Media function calls through the injected gateway transport." },
  "src/engine/render/hyperframesCloud.ts": { kind: "transport", governed: "gateway", note: "Render calls through the injected gateway transport." },
  "src/engine/render/shotstack.ts": { kind: "transport", governed: "gateway", note: "Render calls through gateway.transportFor(\"shotstack\")." },

  // Types and fixtures: no request is made at run time
  "src/lib/meridian/sources/types.ts": { kind: "types", governed: "n/a", note: "A type declaration. No request is made here." },
};

/**
 * The paid and side-effecting paths with no guard in this code, and why. This list is asserted exactly. Removing a path from it means its
 * guard exists and a test proves it, which the inventory above must then say.
 */
const BLOCKED: Record<string, string> = {
  "src/lib/meridian/decisions/openai-engine.ts": "OpenAI decision calls are not held in the ledger.",
  "src/lib/meridian/jev/router.ts": "TypeSafe JEV decisions are not held in the ledger.",
  "src/lib/meridian/perception/multimodal.ts": "Gemini perception calls are not held in the ledger.",
  "src/lib/meridian/production/providers/higgsfield.ts": "Higgsfield video generation is not held in the ledger.",
  "src/lib/meridian/production/providers/omni.ts": "Gemini omni generation is not held in the ledger.",
  "src/lib/meridian/providers/nano-banana.server.ts": "Gemini image generation is not held in the ledger.",
  "src/lib/meridian/embeddings/external.ts": "The paid embeddings API is not held in the ledger.",
  "src/lib/meridian/storage/drive.ts": "Drive writes have no idempotency key, so a retry can duplicate a file.",
  "src/lib/meridian/storage/drive-resumable.ts": "Resumable Drive uploads have no idempotency key, so a retry can duplicate a file.",
  "src/lib/meridian/alerts/deliver.ts": "Alert webhooks have no guard.",
  "src/lib/meridian/notifications/email.ts": "Outbound email has no guard.",
  "src/lib/meridian/jobs/execute.ts": "The job executor sends the request a job carries, with no guard of its own.",
  "src/lib/meridian/hypit/client.ts": "The Hypit client sends the request. The Meta publish that calls it (publishing/hypit-meta.ts) has an idempotency key and an approval step, but neither reaches the request here.",
  "src/lib/meridian/studio/hypit-run.ts": "A Hypit run has no guard of its own.",
  "src/lib/meridian/distribution/facebook.ts": "Facebook writes carry no idempotency key.",
  "src/lib/meridian/distribution/instagram.ts": "Instagram writes carry no idempotency key.",
  "src/lib/meridian/distribution/tiktok.ts": "TikTok writes carry no idempotency key.",
  "src/lib/meridian/distribution/youtube.ts": "YouTube writes carry no idempotency key.",
  "src/lib/meridian/providers/meta.ts": "The Meta ad path is not verified idempotent here.",
  "src/lib/meridian/providers/google-ads.ts": "Google Ads writes have no guard.",
  "src/lib/meridian/providers/tiktok.ts": "TikTok calls, including writes, have no guard.",
  "src/lib/meridian/content-factory/repurpose-upload-service.ts": "The upload service's request is not verified idempotent.",
  "src/lib/meridian/providers/publish-action.ts": "The paused publish stores idempotency keys, but no test in this repository exercises it.",
};

/** A direct fetch call. Engine code may not make one at all. */
const DIRECT_CALL = /(?<!async )(?<!function )(?<![\w.])(?:fetch|fetchImpl)\s*\(|globalThis\.fetch\s*\(|this\.(?:fetchImpl|fetchFn)\s*\(/;
/** A call to the shared request helper. Engine code may not make one. */
const LIB_HELPER_CALL = /\b(?:liveTransport|sendWithRetry)\s*\(/;
/** A request made through a transport a caller passed in, such as `transport(...)` or `deps.transport.send(...)`. */
const INJECTED_CALL = /(?<![\w])transport\s*\(|\btransport\.(?:request|send|post|get|fetch)\s*\(/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      if (name.name === "test" || name.name === "node_modules") continue;
      out.push(...sourceFiles(path));
    } else if ((name.name.endsWith(".ts") || name.name.endsWith(".tsx")) && !name.name.endsWith(".d.ts") && !name.name.includes(".test.")) {
      out.push(path);
    }
  }
  return out;
}

/** Code lines only: comments are not requests. */
function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

function requestingFiles(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(join(ROOT, "src"))) {
    const rel = relative(ROOT, file);
    const code = codeOf(readFileSync(file, "utf8"));
    if (DIRECT_CALL.test(code) || LIB_HELPER_CALL.test(code) || INJECTED_CALL.test(code)) found.push(rel);
  }
  return found.sort();
}

test("every file that makes a request is classified in the inventory, and every entry still makes one", () => {
  const found = requestingFiles();
  const missing = found.filter((file) => !(file in INVENTORY));
  const stale = Object.keys(INVENTORY).filter((file) => !found.includes(file));
  assert.deepEqual(missing, [], "classify each new request site in direct-requests.test.ts");
  assert.deepEqual(stale, [], "remove each inventory entry whose file no longer makes a request");
});

test("a guard named as evidence is a test file that exists", () => {
  for (const [file, entry] of Object.entries(INVENTORY)) {
    if (entry.governed !== "guarded") continue;
    assert.ok(entry.evidence, `${file} names a guard but no evidence`);
    assert.ok(existsSync(join(ROOT, entry.evidence)), `${file}: ${entry.evidence} does not exist`);
  }
});

test("every paid or side-effecting request is guarded by a named test, or is listed as BLOCKED", () => {
  const unguarded = Object.entries(INVENTORY)
    .filter(([, entry]) => COSTLY_OR_EXTERNAL.has(entry.kind) && (entry.governed === "none"))
    .map(([file]) => file)
    .sort();
  assert.deepEqual(unguarded, Object.keys(BLOCKED).sort(), "the BLOCKED list is exactly the unguarded paid and side-effecting paths");
});

test("the BLOCKED list is a statement of gaps: each names a reason", () => {
  for (const [file, reason] of Object.entries(BLOCKED)) {
    assert.ok(reason.length > 10, `${file} has a reason`);
  }
});

test("no engine file makes a request except the gateway's transport", () => {
  const engineFiles = sourceFiles(join(ROOT, "src", "engine")).map((file) => relative(ROOT, file));
  const direct = engineFiles.filter((file) => file !== "src/engine/gateway/transport.ts").filter((file) => {
    const code = codeOf(readFileSync(join(ROOT, file), "utf8"));
    return DIRECT_CALL.test(code) || LIB_HELPER_CALL.test(code);
  });
  assert.deepEqual(direct, [], "no engine file calls fetch or the lib helper; engine code reaches providers through an injected gateway transport");
  // An engine file that calls an injected transport must be wired to the gateway, which the inventory records.
  for (const file of requestingFiles().filter((f) => f.startsWith("src/engine/"))) {
    assert.equal(INVENTORY[file]?.governed, "gateway", `${file} is engine code and must be governed by the gateway`);
  }
});
