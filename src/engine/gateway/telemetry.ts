// Per-call telemetry (migration 0110, Bible 14.1): what each paid call's provider request measured. The ledger stays the money
// record. This module reads only what the gateway saw: the wall clock around the provider request, the generation id and token counts
// the response gave, and the cost the response reported as usage.cost. Nothing is estimated, and no unknown value is written as zero.
//
// How a call is measured. paidCall opens a probe around its run. The gateway makes one sample for each request it sends, and adds it to
// the open probe just before the transport is called, so a request that failed still has one. The OpenRouter functions complete the
// sample with what the response reported. The probe closes when the run settles, so a request made after that does not count. A call
// that never reached the transport (not connected, refused) makes no sample and writes no row.
//
// Nothing here sends a request, retries, or looks anything up. The row keeps no prompt, no response body, no headers, no key and no
// error text.

import { AsyncLocalStorage } from "node:async_hooks";

/** The largest value an integer column holds (Postgres integer). A count or a latency above it is unknown, not stored. */
const MAX_INTEGER = 2_147_483_647;
/** The longest generation id the table accepts (engine_call_telemetry.generation_id). */
const MAX_GENERATION_ID_LENGTH = 256;

/** One provider request the gateway sent. The caller completes it with what the response reported. */
export type RequestSample = {
  provider: string;
  /** The workspace the request was made for. Null for deployment-wide work, which writes no telemetry row. */
  organizationId: string | null;
  /** Wall clock around the provider request that answered, in whole milliseconds. Null when the clock gave no usable reading. */
  latencyMs: number | null;
  generationId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** The cost the response reported as usage.cost, in USD and not yet rounded. */
  costUsd: number | null;
};

/** The samples of one paid call. Open while its run is in progress. */
export type RequestProbe = { samples: RequestSample[]; open: boolean };

const probes = new AsyncLocalStorage<RequestProbe>();

export function newSample(provider: string, organizationId: string | null): RequestSample {
  return { provider, organizationId, latencyMs: null, generationId: null, promptTokens: null, completionTokens: null, costUsd: null };
}

export function newProbe(): RequestProbe {
  return { samples: [], open: true };
}

/** Runs one paid call's work with the probe open. The probe closes when the work settles, whether it returned or threw. */
export async function probeRequests<T>(probe: RequestProbe, work: () => Promise<T>): Promise<T> {
  try {
    return await probes.run(probe, work);
  } finally {
    probe.open = false;
  }
}

/** Adds a sample to the probe of the paid call the gateway is serving, once. Outside a paid call, or after it settled, nothing is kept. */
export function markSent(sample: RequestSample): void {
  const probe = probes.getStore();
  if (probe?.open && !probe.samples.includes(sample)) probe.samples.push(sample);
}

/** The time between two readings of the injected clock, in whole milliseconds, or null when the readings give no usable time. */
export function elapsedMs(started: number, ended: number): number | null {
  const elapsed = ended - started;
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const rounded = Math.round(elapsed);
  return rounded <= MAX_INTEGER ? rounded : null;
}

function idOrNull(value: string | null): string | null {
  return value !== null && value.length >= 1 && value.length <= MAX_GENERATION_ID_LENGTH ? value : null;
}

function countOrNull(value: number | null): number | null {
  return value !== null && Number.isInteger(value) && value >= 0 && value <= MAX_INTEGER ? value : null;
}

function moneyOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Completes a sample with what a response reported. A value that is not a usable id, count or amount is kept as null. */
export function noteAnswer(
  sample: RequestSample,
  answer: { generationId: string | null; promptTokens: number | null; completionTokens: number | null; costUsd: number | null },
): void {
  sample.generationId = idOrNull(answer.generationId);
  sample.promptTokens = countOrNull(answer.promptTokens);
  sample.completionTokens = countOrNull(answer.completionTokens);
  sample.costUsd = moneyOrNull(answer.costUsd);
}

/**
 * A cost rounded UP to the ledger's four decimals. This is the rule of budget/reconcile.ts (billUsdUp), copied here because that
 * function is private to the budget; a test checks that the two agree. Rounding up records at most $0.0001 more than the response
 * reported, never less, so a hard budget is not under-counted.
 */
export function usdUpToFour(usd: number): number {
  const rounded = Math.ceil(usd * 10000 - 1e-6) / 10000;
  return rounded === 0 ? 0 : rounded;
}

export type CallTelemetry = {
  provider: string;
  model: string;
  generationId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number | null;
  responseCostUsd: number | null;
};

export type CallTelemetryRecord = CallTelemetry & { ledgerEntryId: string; organizationId: string };

/** A store that keeps one call's telemetry row. A Postgres budget transaction offers it (jobs/call-telemetry-sql.ts). */
export interface CallTelemetryStore {
  recordCallTelemetry(record: CallTelemetryRecord): Promise<void>;
}

/**
 * The telemetry of one paid call, from the samples its run recorded. Null when no request reached the provider, or when a sample
 * belongs to another workspace or to none: such a call writes no row, as the ledger writes none for a call with no organization.
 * One sample is one request, so its values are the call's own. Two or more samples, or a sample to another provider, cannot be
 * attributed to one response, so every measured value is null and only the identity (provider and model) is known.
 */
export function callTelemetryOf(
  samples: readonly RequestSample[],
  call: { organizationId: string; provider: string; model: string },
): CallTelemetry | null {
  if (samples.length === 0) return null;
  if (samples.some((sample) => sample.organizationId !== call.organizationId)) return null;
  const identity = { provider: call.provider, model: call.model };
  const sample = samples[0];
  if (sample === undefined) return null;
  if (samples.length > 1 || sample.provider !== call.provider) {
    return { ...identity, generationId: null, promptTokens: null, completionTokens: null, latencyMs: null, responseCostUsd: null };
  }
  return {
    ...identity,
    generationId: sample.generationId,
    promptTokens: sample.promptTokens,
    completionTokens: sample.completionTokens,
    latencyMs: sample.latencyMs,
    responseCostUsd: sample.costUsd === null ? null : usdUpToFour(sample.costUsd),
  };
}

/** The fixed message logged when a telemetry row cannot be written. It names no error text, no key and no prompt. */
export const TELEMETRY_NOT_RECORDED = "engine: a paid call's telemetry row was not recorded; the call and its ledger entry are unchanged";

export function logTelemetryNotRecorded(): void {
  console.warn(TELEMETRY_NOT_RECORDED);
}

/**
 * Keeps one call's telemetry row through a store that offers it. It never throws: a store without the method keeps nothing, and a
 * failed write is logged with the fixed message. The caller's result and ledger row do not depend on it.
 */
export async function keepCallTelemetry(store: Partial<CallTelemetryStore>, record: CallTelemetryRecord): Promise<void> {
  if (typeof store.recordCallTelemetry !== "function") return;
  try {
    await store.recordCallTelemetry(record);
  } catch {
    logTelemetryNotRecorded();
  }
}
