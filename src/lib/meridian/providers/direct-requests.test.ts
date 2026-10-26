// Every place Meridian's code makes an outbound request, classified. Engine code makes its provider requests only through the gateway
// (src/engine/gateway). The lib code makes its own, through a direct fetch or the shared request helper (providers/http.ts), and those
// requests are not held by the engine gateway. This test is the inventory:
//
// - A new file that makes a request fails until it is classified here.
// - An entry whose file no longer makes a request fails, so the inventory cannot go stale.
// - A paid or side-effecting request must name the guard that governs it, and a guard must point at a test that exists.
// - A paid or side-effecting request must be held in the ledger, guarded by a tested lib-level guard, or disabled. A disabled path has a
//   default transport that refuses before any request is made (providers/capability.ts). Nothing is left unguarded.
// - Each disabled path names its capability, and each capability is named by a file and passed to its gate in production code.
//
// The inventory is a statement of what the code does today. A disabled path is off until its guard exists, and turning it on is a change
// that this test records.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { DISABLED_CAPABILITIES, type DisabledCapability } from "./capability.ts";

const ROOT = process.cwd();

/** Kinds that cost money or change something outside Meridian. Every entry of these kinds is held, guarded, or disabled. */
const COSTLY_OR_EXTERNAL = new Set(["paid", "side_effect"]);

/** The test that proves every disabled capability refuses without a request. */
const CAPABILITY_TEST = "src/lib/meridian/providers/capability.test.ts";

type Entry = {
  kind: "transport" | "transport_helper" | "paid" | "side_effect" | "read" | "probe" | "auth" | "internal" | "fixture" | "types";
  /**
   * "gateway" and "ledger" are the engine's guards; "guarded" names a test that proves a lib-level guard; "disabled" means the path's
   * default transport refuses (providers/capability.ts); "none" means no guard, and no paid or side-effecting entry may have it.
   */
  governed: "gateway" | "ledger" | "guarded" | "disabled" | "none" | "n/a";
  /** For "guarded" and "disabled": the test file that proves the guard. It must exist. */
  evidence?: string;
  /** For "disabled": the capability whose gate this file uses or is wired to. */
  capability?: DisabledCapability;
  note: string;
};

const INVENTORY: Record<string, Entry> = {
  "src/engine/gateway/transport.ts": { kind: "transport", governed: "gateway", note: "The engine's one transport. Keys come from the resolver." },
  "src/lib/meridian/providers/http.ts": { kind: "transport_helper", governed: "n/a", note: "The shared request helper for lib code. Its callers are listed below." },

  // Decisions and JEV
  "src/lib/meridian/decisions/decision-catalog.ts": { kind: "read", governed: "n/a", note: "OpenRouter's public model catalogue, read without a key." },
  "src/lib/meridian/decisions/openai-engine.ts": { kind: "paid", governed: "disabled", capability: "decision.openai", evidence: CAPABILITY_TEST, note: "OpenAI Decisions. Off until its calls are held in the ledger." },
  "src/lib/meridian/decisions/openrouter-engine.ts": {
    kind: "paid",
    governed: "ledger",
    note: "OpenRouter Decisions. Each call is held in the ledger before it is sent and settled once.",
  },
  "src/lib/meridian/jev/router.ts": { kind: "paid", governed: "disabled", capability: "decision.typesafe_jev", evidence: CAPABILITY_TEST, note: "TypeSafe JEV decisions, the default JEV backend. Off until its calls are held." },

  // Generation through providers outside the gateway
  "src/lib/meridian/perception/multimodal.ts": { kind: "paid", governed: "disabled", capability: "perception.gemini", evidence: CAPABILITY_TEST, note: "Gemini perception calls. Off until they are held in the ledger." },
  "src/lib/meridian/production/providers/higgsfield.ts": { kind: "paid", governed: "disabled", capability: "generation.higgsfield_video", evidence: CAPABILITY_TEST, note: "Higgsfield video generation. Off until it is held in the ledger." },
  "src/lib/meridian/production/providers/omni.ts": { kind: "paid", governed: "disabled", capability: "generation.gemini_omni", evidence: CAPABILITY_TEST, note: "Gemini omni generation. Off until it is held in the ledger." },
  "src/lib/meridian/providers/nano-banana.server.ts": { kind: "paid", governed: "disabled", capability: "generation.gemini_image", evidence: CAPABILITY_TEST, note: "Gemini image generation. Off until it is held in the ledger." },
  "src/lib/meridian/embeddings/external.ts": { kind: "paid", governed: "disabled", capability: "embeddings.external", evidence: CAPABILITY_TEST, note: "A paid embeddings API. Off until it is held in the ledger." },

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

  // Side effects. Each is disabled: its default transport refuses before any request is made, until its guard exists.
  "src/lib/meridian/providers/publish-action.ts": { kind: "side_effect", governed: "disabled", capability: "publish.paused_action", evidence: CAPABILITY_TEST, note: "The paused publish action. Off until a test proves its idempotency keys." },
  "src/lib/meridian/storage/drive.ts": { kind: "side_effect", governed: "disabled", capability: "drive.write", evidence: CAPABILITY_TEST, note: "Google Drive writes and reads. Off; files are kept in Postgres." },
  "src/lib/meridian/storage/drive-resumable.ts": { kind: "side_effect", governed: "disabled", capability: "drive.write", evidence: CAPABILITY_TEST, note: "Resumable Drive uploads. Their transport comes from drive.ts, which is off." },
  "src/lib/meridian/alerts/deliver.ts": { kind: "side_effect", governed: "disabled", capability: "alerts.webhook", evidence: CAPABILITY_TEST, note: "Alert webhooks. Its only caller, the job executor, uses the same off capability." },
  "src/lib/meridian/notifications/email.ts": { kind: "side_effect", governed: "disabled", capability: "email.send", evidence: CAPABILITY_TEST, note: "Outbound email. Off until a send has an idempotency key." },
  "src/lib/meridian/jobs/execute.ts": { kind: "side_effect", governed: "disabled", capability: "alerts.webhook", evidence: CAPABILITY_TEST, note: "The job executor's alert delivery. Off through the webhook capability." },
  "src/lib/meridian/hypit/client.ts": { kind: "side_effect", governed: "disabled", capability: "hypit.client", evidence: CAPABILITY_TEST, note: "The Hypit bridge client. Its transport comes from the caller; the lib run is off." },
  "src/lib/meridian/studio/hypit-run.ts": { kind: "side_effect", governed: "disabled", capability: "hypit.client", evidence: CAPABILITY_TEST, note: "Starts a Hypit run. Off through the Hypit capability." },
  "src/lib/meridian/distribution/facebook.ts": { kind: "side_effect", governed: "disabled", capability: "publish.facebook", evidence: CAPABILITY_TEST, note: "Facebook publishing. Off; the guarded path is the organic publish with receipts." },
  "src/lib/meridian/distribution/instagram.ts": { kind: "side_effect", governed: "disabled", capability: "publish.instagram", evidence: CAPABILITY_TEST, note: "Instagram publishing and its reads. Off, since they share one transport." },
  "src/lib/meridian/distribution/tiktok.ts": { kind: "side_effect", governed: "disabled", capability: "publish.tiktok", evidence: CAPABILITY_TEST, note: "TikTok publishing. Off until it has an idempotency key." },
  "src/lib/meridian/distribution/youtube.ts": { kind: "side_effect", governed: "disabled", capability: "publish.youtube", evidence: CAPABILITY_TEST, note: "YouTube publishing. Off until it has an idempotency key." },
  "src/lib/meridian/providers/meta.ts": { kind: "side_effect", governed: "disabled", capability: "ads.meta_write", evidence: CAPABILITY_TEST, note: "Meta ad writes. Their transport is gated in providers/live.ts. The guarded path is meta-paused-ad.ts." },
  "src/lib/meridian/providers/google-ads.ts": { kind: "side_effect", governed: "disabled", capability: "ads.google_ads_write", evidence: CAPABILITY_TEST, note: "Google Ads writes. Their transport is gated in providers/live.ts." },
  "src/lib/meridian/providers/tiktok.ts": { kind: "side_effect", governed: "disabled", capability: "ads.tiktok_write", evidence: CAPABILITY_TEST, note: "TikTok ad writes. Their transport is gated in providers/live.ts." },
  "src/lib/meridian/content-factory/repurpose-upload-service.ts": { kind: "side_effect", governed: "disabled", capability: "publish.meta_video_upload", evidence: CAPABILITY_TEST, note: "The Meta video upload. Off until it is verified idempotent." },

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

/** Whether a file's code hands a request to a disabled capability's gate, so the request is off in this file. */
function wiresGate(file: string): boolean {
  return /\bgated(?:Fetch|Transport)\(/.test(codeOf(readFileSync(join(ROOT, file), "utf8")));
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
  // A disabled entry may be a caller that only hands its transport to the callee that sends. It must still wire its gate.
  const stale = Object.keys(INVENTORY).filter((file) => !found.includes(file) && !(INVENTORY[file]?.governed === "disabled" && wiresGate(file)));
  assert.deepEqual(missing, [], "classify each new request site in direct-requests.test.ts");
  assert.deepEqual(stale, [], "remove each inventory entry whose file no longer makes a request");
});

test("a guard named as evidence is a test file that exists", () => {
  for (const [file, entry] of Object.entries(INVENTORY)) {
    if (entry.governed !== "guarded" && entry.governed !== "disabled") continue;
    assert.ok(entry.evidence, `${file} names a guard but no evidence`);
    assert.ok(existsSync(join(ROOT, entry.evidence)), `${file}: ${entry.evidence} does not exist`);
  }
});

test("no paid or side-effecting request is unguarded: each is held in the ledger, guarded by a tested guard, or disabled", () => {
  const unguarded = Object.entries(INVENTORY)
    .filter(([, entry]) => COSTLY_OR_EXTERNAL.has(entry.kind) && entry.governed === "none")
    .map(([file]) => file)
    .sort();
  assert.deepEqual(unguarded, [], "a paid or side-effecting path must be held, guarded, or disabled");
});

test("each disabled path names a capability that exists, every capability is named, and each is passed to its gate in production code", () => {
  const named = new Set<DisabledCapability>();
  for (const [file, entry] of Object.entries(INVENTORY)) {
    if (entry.governed !== "disabled") continue;
    assert.ok(entry.capability && entry.capability in DISABLED_CAPABILITIES, `${file} names a capability in providers/capability.ts`);
    named.add(entry.capability);
  }
  const unnamed = (Object.keys(DISABLED_CAPABILITIES) as DisabledCapability[]).filter((capability) => !named.has(capability));
  assert.deepEqual(unnamed, [], "every disabled capability is used by a classified file");
  const production = sourceFiles(join(ROOT, "src"))
    .filter((file) => !file.endsWith("providers/capability.ts"))
    .map((file) => readFileSync(file, "utf8"));
  for (const capability of named) {
    assert.ok(
      production.some((source) => source.includes(`"${capability}"`)),
      `${capability} is passed to its gate in production code`,
    );
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
