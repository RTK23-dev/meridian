/**
 * Live smoke test. Talks to a separate Hypit process.
 * Not part of the mocked unit suite.
 */
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { liveTransport } from "../src/lib/meridian/providers/http.ts";
import { handoffToHypit, memoryHypitLedger } from "../src/lib/meridian/hypit/handoff.ts";
import { storeHypitArtifact } from "../src/lib/meridian/hypit/store.ts";

const port = process.env.HYPIT_BRIDGE_PORT || "8766";
const baseUrl = process.env.HYPIT_BASE_URL || `http://127.0.0.1:${port}`;
const hypitBin = process.env.HYPIT_BIN || "/opt/hypit-runtime/node_modules/.bin/hypit";
const ffprobe = process.env.HYPIT_FFPROBE || "/tmp/ffprobe-pkg/node_modules/ffprobe-static/bin/linux/x64/ffprobe";

function waitForHealth(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Hypit bridge did not start.")), 15000);
    const onData = (chunk) => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Hypit bridge exited ${code} before listening.`));
    });
  });
}

const bridge = spawn(process.execPath, ["scripts/hypit-bridge.mjs"], {
  env: {
    ...process.env,
    HYPIT_BIN: hypitBin,
    HYPIT_FFPROBE: ffprobe,
    HYPIT_FFMPEG: process.env.HYPIT_FFMPEG || "/usr/local/bin/ffmpeg",
    HYPIT_BRIDGE_PORT: String(port),
    HYPIT_BASE_URL: baseUrl,
  },
  stdio: ["ignore", "pipe", "inherit"],
});
await waitForHealth(bridge);

try {
  const ledger = memoryHypitLedger();
  const stored = [];
  const result = await handoffToHypit(
    {
      organizationId: "org-live",
      brandId: "brand-live",
      product: "North bar",
      objective: "Show the lather in the first second.",
      angle: "demonstration",
      visualDirection: "Close product. No extra promise.",
      tone: "quiet",
      cta: "See the bar",
      format: "short_ugc",
      aspectRatio: "9:16",
      durationSeconds: 2,
      requiredClaims: ["lathers"],
      prohibitedClaims: ["cures"],
      brandAssets: [],
      briefId: "brief-live",
      decision: {
        id: "dec-live",
        organizationId: "org-live",
        brandId: "brand-live",
        questionId: "brief_gate",
        policyVersion: "code:brief_gate.v1",
        decision: "AUTO_APPROVE",
        reviewerDecision: "",
        reasons: ["Stored evidence supports this angle."],
        evidence: [{ id: "ev-live", source: "market", summary: "The lather is visible." }],
      },
    },
    {
      env: { baseUrl },
      transport: liveTransport(),
      ledger,
      onArtifact: async (artifact) => {
        stored.push(artifact);
        await writeFile("/tmp/meridian-hypit-live.mp4", artifact.bytes);
      },
    },
  );
  if (!result.ok || !result.artifactBytes) {
    console.error(JSON.stringify({ ok: false, job: result.job }, null, 2));
    process.exitCode = 1;
  } else {
    const statements = [];
    const sql = Object.assign(async (strings) => {
      statements.push(strings.join("?"));
      return [];
    }, { query: async () => [] });
    const saved = await storeHypitArtifact(sql, result.job, result.artifactBytes);
    const digest = createHash("sha256").update(result.artifactBytes).digest("hex");
    console.log(JSON.stringify({
      ok: true,
      status: result.job.status,
      provider: result.job.provider,
      providerJobId: result.job.providerJobId,
      jevDecisionId: result.job.contract.lineage.jevDecisionId,
      briefId: result.job.contract.lineage.briefId,
      storageKey: result.job.artifact?.storageKey ?? "",
      sha256: digest,
      storedChecksum: saved.checksum,
      byteLength: result.artifactBytes.byteLength,
      mime: result.job.artifact?.mime ?? "",
      durationMs: result.job.artifact?.durationMs ?? null,
      width: result.job.artifact?.width ?? null,
      height: result.job.artifact?.height ?? null,
      blobInsert: statements[0]?.includes("asset_blobs") === true,
    }, null, 2));
  }
} finally {
  bridge.kill("SIGTERM");
}
