// Test helpers for the stage handlers and the end-to-end flow. Nothing here calls a live API: the gateway's transport answers from
// recorded responses (fixtures/, copied from the asset and review fixtures and labelled there), the media functions are fakes
// with recorded shapes, and the object store is in memory. A request the script does not expect throws, so a test fails when the
// code calls a provider it was not meant to call.

import { readFileSync } from "node:fs";
import { createGateway, type Gateway } from "../../gateway/gateway.ts";
import type { CredentialLookup, CredentialSource, HttpRequest, HttpResponse, HttpTransport } from "../../gateway/types.ts";
import type { MediaFunctions, ProbeResult } from "../../media/interface.ts";
import type { MediaStorePort } from "../artifact-store.ts";
import type { Sql } from "../../../lib/meridian/learning/store.ts";
import { executeEngineJob } from "../dispatch.ts";
import type { EngineRuntime, StageHandler } from "../types.ts";
import { withReservationLedger } from "../sql-ledger-store.ts";
import { reconcileCall } from "../../budget/reconcile.ts";
import type { SimilarityScorer } from "../../review/take/similarity.ts";
import type { ExecutableJob } from "../../../lib/meridian/jobs/execute.ts";

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

export function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) };
}

export function raw(status: number, body: Uint8Array): HttpResponse {
  return { status, headers: { "content-type": "video/mp4" }, body };
}

export type Reply = HttpResponse | ((request: HttpRequest) => HttpResponse);

/** A transport keyed by "METHOD pathname". Each key answers in order, and the last reply repeats. Unknown requests throw. */
export function recordedTransport(script: Record<string, Reply | Reply[]>): { transport: HttpTransport; requests: HttpRequest[] } {
  const queues = new Map(Object.entries(script).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]));
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    const key = `${request.method} ${new URL(request.url).pathname}`;
    const queue = queues.get(key);
    if (!queue || queue.length === 0) throw new Error(`unexpected request in the recorded script: ${key}`);
    const reply = queue.length > 1 ? (queue.shift() as Reply) : (queue[0] as Reply);
    return typeof reply === "function" ? reply(request) : reply;
  };
  return { transport, requests };
}

export function keySource(keys: Record<string, string>): CredentialSource {
  return {
    async get(credentialId): Promise<CredentialLookup> {
      const secret = keys[credentialId];
      return secret ? { status: "ready", credential: { kind: "api_key", secret } } : { status: "not_connected", reason: `no ${credentialId} key` };
    },
  };
}

export function gatewayWith(transport: HttpTransport): Gateway {
  return createGateway({ transport, credentials: keySource({ openrouter: "sk-or-test", pexels: "pexels-test" }) });
}

/** A valid mp4 header (ftyp at byte 4). The bytes are a stand-in: the probe that reads them is a fake with a recorded shape. */
export const MP4_BYTES = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);

/** A second stand-in file, longer than the first, for the stock clip (the probe fake tells the two apart by their length). */
export const MP4_STOCK_BYTES = new Uint8Array([...MP4_BYTES, 0, 0, 0, 0, 0, 0, 0, 0]);

/** A 1 x 1 PNG, as a frame. Only its bytes are passed on (to the Critic's data URL). */
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** A probe answer in the shape the media functions give (ProbeResult). */
export function probeOf(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    videoCodec: "h264",
    audioCodec: null,
    width: 1080,
    height: 1920,
    fps: { num: 30, den: 1, value: 30 },
    durationMs: 5000,
    audioPresent: false,
    bytes: MP4_BYTES.byteLength,
    ...overrides,
  };
}

/** Media functions that answer with the recorded shapes. Each call is recorded, so a test can check what was asked. */
export function fakeMedia(options: { probe?: (bytes: Uint8Array) => ProbeResult } = {}): Pick<MediaFunctions, "probe" | "frames"> & { probes: number; frameCalls: number[][] } {
  const state = { probes: 0, frameCalls: [] as number[][] };
  return {
    get probes() {
      return state.probes;
    },
    get frameCalls() {
      return state.frameCalls;
    },
    async probe(request) {
      state.probes += 1;
      const bytes = request.source.kind === "bytes" ? request.source.bytes : new Uint8Array();
      return options.probe ? options.probe(bytes) : probeOf();
    },
    async frames(request) {
      state.frameCalls.push([...request.atMs]);
      return { frames: request.atMs.map((atMs) => ({ atMs, width: 1, height: 1, png: PNG_1X1 })) };
    },
  };
}

/** An in-memory object store with the port's shape. Keys are per organization and brand, as the Drive store keys them. */
export function fakeObjects(): MediaStorePort & { objects: Map<string, { mimeType: string; bytes: Uint8Array }> } {
  const objects = new Map<string, { mimeType: string; bytes: Uint8Array }>();
  const slot = (organizationId: string, brandId: string, key: string) => `${organizationId}|${brandId}|${key}`;
  return {
    objects,
    async put(input) {
      objects.set(slot(input.organizationId, input.brandId, input.key), { mimeType: input.mimeType, bytes: input.bytes });
      return { key: input.key, checksum: "fake", size: input.bytes.byteLength };
    },
    async get(organizationId, brandId, key) {
      const found = objects.get(slot(organizationId, brandId, key));
      return found ? { bytes: found.bytes, mimeType: found.mimeType } : null;
    },
  };
}

/** The job row Meridian's worker would claim, read back from the jobs table. */
type JobRow = { id: string; organization_id: string; brand_id: string | null; job_type: string; payload: string; max_attempts: number };

/**
 * Runs every queued job of one type through the real dispatcher, in key order, marking each succeeded. It returns how many ran.
 * A job that throws stops the run with its error, so a test sees the failure rather than a silent skip.
 */
export async function runQueued(sql: Sql, runtime: EngineRuntime, jobType: string): Promise<number> {
  const rows = await sql<JobRow>`
    select id, organization_id, brand_id, job_type, payload, max_attempts from jobs
    where job_type = ${jobType} and status = 'queued' order by idempotency_key
  `;
  for (const row of rows) {
    const job: ExecutableJob = {
      id: row.id,
      organization_id: row.organization_id,
      brand_id: row.brand_id,
      job_type: row.job_type,
      payload: row.payload,
      attempts: 0,
      max_attempts: row.max_attempts,
    };
    await executeEngineJob(sql, job, runtime);
    await sql`update jobs set status = 'succeeded' where id = ${row.id}`;
  }
  return rows.length;
}

/** A similarity scorer answering from recorded scores by kind. A kind with no recorded score is not connected (Bible 12). */
export function scorerFrom(scores: Partial<Record<"product_vs_hero" | "face_vs_persona" | "palette_vs_style_kit", number>>): SimilarityScorer {
  return {
    id: "similarity:recorded",
    async score(request) {
      const score = scores[request.kind];
      if (score === undefined) return { status: "not_connected", reason: `no recorded score for ${request.kind}` };
      return { status: "scored", score, scorer: "similarity:recorded" };
    },
  };
}

/**
 * Records the bill of every open render of a reservation, at the list price the render quoted (its ledger estimate). HyperFrames
 * reports no bill from its provider (render/hyperframesCloud.ts), so the bill here stands for the owner's invoice, recorded before the
 * request is delivered (contract v6). Returns how many renders it billed. A render already settled is left as it is.
 */
export async function billOpenRenders(sql: Sql, organizationId: string, reservationId: string): Promise<number> {
  return withReservationLedger(sql, organizationId, reservationId, async (ledger) => {
    let billed = 0;
    for (const row of await ledger.listEntries(reservationId)) {
      if (row.stage !== "render" || row.settlement !== undefined) continue;
      await reconcileCall(ledger, { idempotencyKey: row.idempotencyKey, billedUsd: row.estimateUsd });
      billed += 1;
    }
    return billed;
  });
}

/**
 * The runtime with its deliver stage preceded by billOpenRenders, so a drained request is delivered once its renders are billed. The
 * deliver stage refuses while any paid call is open (deliver/ledger.ts), so the queue cannot deliver without this. Nothing else of the
 * runtime changes, and the runtime passed in is not mutated.
 */
export function withRenderBills(sql: Sql, runtime: EngineRuntime): EngineRuntime {
  const deliver = runtime.handlers.deliver;
  if (deliver === undefined) return runtime;
  const billing: StageHandler = {
    async run(ctx) {
      const reservationId = ctx.payload.budgetReservationId;
      if (reservationId !== null) await billOpenRenders(sql, ctx.organizationId, reservationId);
      return deliver.run(ctx);
    },
  };
  return { ...runtime, handlers: { ...runtime.handlers, deliver: billing } };
}
