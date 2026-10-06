import { createHash } from "node:crypto";
import type { PerformanceEvent } from "../performance/normalize.ts";

export type TestPublishReceipt = {
  sha256: string;
  byteLength: number;
  mime: string;
};

export type TestPublishArtifact = {
  bytes: Uint8Array;
  mime: string;
  sha256: string;
};

/** Explicit test double. Production callers must pass allowTestProvider. Ids are prefixed test:. */
export function testProviderPublish(
  creativeId: string,
  allowTestProvider: boolean,
  artifact?: TestPublishArtifact,
): { externalId: string; mode: "test"; receipt?: TestPublishReceipt } {
  if (!allowTestProvider) throw new Error("The test publishing provider is not enabled.");
  if (!creativeId.trim()) throw new Error("The test provider needs a creative id.");
  if (!artifact) return { externalId: `test:${creativeId}`, mode: "test" };
  const sha256 = createHash("sha256").update(artifact.bytes).digest("hex");
  const head = Buffer.from(artifact.bytes.subarray(0, 32)).toString("latin1");
  const video = artifact.mime.startsWith("video/") && artifact.bytes.byteLength >= 16 && head.includes("ftyp") && sha256 === artifact.sha256;
  if (!video) return { externalId: "", mode: "test" };
  return {
    externalId: `test:${creativeId}`,
    mode: "test",
    receipt: { sha256, byteLength: artifact.bytes.byteLength, mime: artifact.mime },
  };
}

export function testProviderPerformance(creativeId: string, allowTestProvider: boolean): PerformanceEvent {
  if (!allowTestProvider) throw new Error("The test performance provider is not enabled.");
  return {
    externalId: `test:${creativeId}:day`,
    creativeId,
    impressions: 1000,
    reach: 800,
    clicks: 40,
    conversions: 4,
    spendCents: 2000,
    revenueCents: 8000,
    currency: "USD",
    timezone: "UTC",
    observedOn: "2026-01-01",
  };
}
