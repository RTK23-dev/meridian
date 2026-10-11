import type { Transport } from "../providers/http.ts";
import { secretForCategory } from "../credentials/resolve.ts";
import { collectHypitArtifact, hypitConnection, pollHypitJob, startHypitJob, type HypitArtifactPayload } from "./client.ts";
import { buildHypitJob, type HypitHandoffInput, type HypitJobContract } from "./contract.ts";

export type HypitJobState = "not_connected" | "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type HypitArtifactRecord = {
  mime: string;
  byteLength: number;
  sha256: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  storageKey: string;
};

export type HypitJobRecord = {
  meridianJobId: string;
  organizationId: string;
  brandId: string;
  provider: "hypit";
  providerJobId: string;
  status: HypitJobState;
  code: string;
  error: string;
  contract: HypitJobContract;
  artifact: HypitArtifactRecord | null;
};

export type HypitLedger = {
  find(organizationId: string, jevDecisionId: string, briefId: string): Promise<HypitJobRecord | null>;
  save(record: HypitJobRecord): Promise<void>;
};

export function memoryHypitLedger(): HypitLedger {
  const rows = new Map<string, HypitJobRecord>();
  const key = (organizationId: string, jevDecisionId: string, briefId: string) =>
    `${organizationId}\0${jevDecisionId}\0${briefId}`;
  return {
    async find(organizationId, jevDecisionId, briefId) {
      return rows.get(key(organizationId, jevDecisionId, briefId)) ?? null;
    },
    async save(record) {
      rows.set(key(record.organizationId, record.contract.lineage.jevDecisionId, record.contract.lineage.briefId), record);
    },
  };
}

export type HypitHandoffOptions = {
  env?: { baseUrl?: string };
  /**
   * The workspace's Hypit key, when the caller already holds it. Without it, the handoff resolves the workspace's key through
   * the credential resolver. A key is never taken from the environment.
   */
  token?: string;
  transport: Transport;
  ledger: HypitLedger;
  /** When true, a failed or not-connected row may be submitted again. The Meridian job id does not change. */
  retry?: boolean;
  onArtifact?: (input: { storageKey: string; mime: string; bytes: Uint8Array }) => Promise<void>;
};

export type HypitHandoffResult = {
  ok: boolean;
  job: HypitJobRecord;
  artifactBytes: Uint8Array | null;
};

function openRecord(contract: HypitJobContract, status: HypitJobState, code: string, error: string): HypitJobRecord {
  return {
    meridianJobId: contract.meridianJobId,
    organizationId: contract.organizationId,
    brandId: contract.brandId,
    provider: "hypit",
    providerJobId: "",
    status,
    code,
    error,
    contract,
    artifact: null,
  };
}

function terminal(record: HypitJobRecord): boolean {
  return record.status === "queued" || record.status === "running" || record.status === "succeeded" || record.status === "cancelled";
}

/**
 * Approved JEV decision → one Hypit job.
 * Does not call xAI. Does not use test:video. Does not invent bytes.
 */
export async function handoffToHypit(input: HypitHandoffInput, options: HypitHandoffOptions): Promise<HypitHandoffResult> {
  const built = buildHypitJob(input);
  if (!built.ok) {
    throw new Error(built.error);
  }
  const existing = await options.ledger.find(input.organizationId, built.contract.lineage.jevDecisionId, built.contract.lineage.briefId);
  if (existing && (terminal(existing) || !options.retry)) {
    return { ok: existing.status === "succeeded", job: existing, artifactBytes: null };
  }
  const token = options.token
    ? { secret: options.token, reason: "" }
    : await secretForCategory("hypit", input.organizationId);
  const connection = hypitConnection({ ...(options.env ?? {}), token: token.secret });
  if (connection.status !== "CONFIGURED") {
    const job = openRecord(built.contract, "not_connected", connection.code, connection.detail);
    await options.ledger.save(job);
    return { ok: false, job, artifactBytes: null };
  }
  if (!token.secret) {
    const job = openRecord(built.contract, "not_connected", "HYPIT_NOT_CONNECTED", token.reason);
    await options.ledger.save(job);
    return { ok: false, job, artifactBytes: null };
  }
  const started = await startHypitJob(connection, built.contract, options.transport);
  if (!started.ok) {
    const job = openRecord(built.contract, "failed", started.code, started.error);
    await options.ledger.save(job);
    return { ok: false, job, artifactBytes: null };
  }
  let remote = started.job;
  if (remote.status === "queued" || remote.status === "running") {
    const polled = await pollHypitJob(connection, remote.providerJobId, options.transport);
    if (!polled.ok) {
      const job = {
        ...openRecord(built.contract, "failed", polled.code, polled.error),
        providerJobId: remote.providerJobId,
      };
      await options.ledger.save(job);
      return { ok: false, job, artifactBytes: null };
    }
    remote = polled.job;
  }
  if (remote.status !== "succeeded") {
    const job = {
      ...openRecord(built.contract, remote.status === "cancelled" ? "cancelled" : remote.status === "failed" ? "failed" : remote.status, remote.status === "failed" ? "HYPIT_FAILED" : "", remote.error),
      providerJobId: remote.providerJobId,
    };
    await options.ledger.save(job);
    return { ok: false, job, artifactBytes: null };
  }
  const collected = await collectHypitArtifact(connection, remote.providerJobId, options.transport);
  if (!collected.ok) {
    const job = {
      ...openRecord(built.contract, "failed", collected.code, collected.error),
      providerJobId: remote.providerJobId,
    };
    await options.ledger.save(job);
    return { ok: false, job, artifactBytes: null };
  }
  const stored = await finishArtifact(built.contract, remote.providerJobId, collected.artifact, options.onArtifact);
  await options.ledger.save(stored.job);
  return { ok: true, job: stored.job, artifactBytes: collected.artifact.bytes };
}

async function finishArtifact(
  contract: HypitJobContract,
  providerJobId: string,
  artifact: HypitArtifactPayload,
  onArtifact: HypitHandoffOptions["onArtifact"],
): Promise<{ job: HypitJobRecord }> {
  const storageKey = `hypit/${contract.organizationId}/${contract.brandId}/${contract.meridianJobId}.mp4`;
  if (onArtifact) await onArtifact({ storageKey, mime: artifact.mime, bytes: artifact.bytes });
  return {
    job: {
      ...openRecord(contract, "succeeded", "", ""),
      providerJobId,
      artifact: {
        mime: artifact.mime,
        byteLength: artifact.bytes.byteLength,
        sha256: artifact.sha256,
        durationMs: artifact.durationMs,
        width: artifact.width,
        height: artifact.height,
        storageKey,
      },
    },
  };
}
