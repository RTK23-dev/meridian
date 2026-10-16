// HyperFrames cloud render adapter (Bible 6.11, 9.3, 14.1). Every render:
//   1. authorizes its budget line against a reservation before any request (LedgerStore entry written first);
//   2. sends the composition as a zip and submits it with Idempotency-Key = Composition.contentHash;
//   3. polls until the render completes or fails, and downloads the video from its signed URL;
//   4. reconciles the ledger, runs the injected render-integrity check, and stores the video.
// The HTTP contract is the one the HyperFrames CLI 0.8.154 calls (see render/README.md for the source lines).
// Keys come only from the injected credential function, which is Meridian's credential resolver at wiring time.
// Steps 1 to 4 are runRender(), which the Shotstack fallback (shotstack.ts) shares; only the payload differs.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  allChecksPass,
  compositionHash,
  compositionSchema,
  contentHash,
  EngineError,
  gateResultSchema,
  newId,
  renderedVideoSchema,
  type Composition,
  type GateResult,
  type RenderedVideo,
} from "../contracts/index.ts";
import { authorizeCall, type BudgetAlert } from "../budget/reserve.ts";
import { reconcileCall } from "../budget/reconcile.ts";
import type { LedgerStore } from "../budget/store.ts";
import type { CompiledAsset, CompiledFile } from "../compose/compiler.ts";
import { buildZip } from "./zip.ts";

export const HYPERFRAMES_CLOUD_RENDERER = "hyperframes-cloud";
/** The ledger's provider and model for a render. The price table has no verified render price yet (prices.ts). */
export const HYPERFRAMES_LEDGER_PROVIDER = "heygen_hyperframes_cloud";
export const HYPERFRAMES_LEDGER_MODEL = "hyperframes";

/** The base the CLI resolves by default (cloud client, HEYGEN_API_URL overrides it). */
export const HEYGEN_API_BASE_URL = "https://api.heygen.com";
/** Sent with every request, as the CLI does (X-HeyGen-Client-Source). */
export const HEYGEN_CLIENT_SOURCE_HEADER = "X-HeyGen-Client-Source";
export const HEYGEN_CLIENT_SOURCE = "hyperframes";

/** Direct uploads go to S3 presigned URLs, and the CLI refuses an archive above this size before it uploads. */
export const DIRECT_UPLOAD_LIMIT_BYTES = 200 * 1024 * 1024;

/** Settings sent with every render. The owner checks them against the first live render (STATUS.md). */
export const RENDER_SETTINGS = {
  fps: 30,
  quality: "standard",
  format: "mp4",
  resolution: "1080p",
  aspectRatio: "9:16",
} as const;

/** The CLI's own defaults for polling (DEFAULT_POLL_INTERVAL_MS and DEFAULT_MAX_WAIT_MS in the cloud client). */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_MAX_POLLS = 360;
/** Retries for a 409 on upload completion, with a linear backoff (COMPLETE_MAX_RETRIES in the CLI). */
export const COMPLETE_MAX_RETRIES = 5;
export const COMPLETE_RETRY_BASE_MS = 500;

/** The render's expected output (Bible 6.11 render integrity). The duration tolerance comes from config. */
export const RENDER_EXPECTATION = { width: 1080, height: 1920, fps: 30 } as const;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_:.-]{1,255}$/;

// ---- transport ---------------------------------------------------------------------------------------------------

export type TransportRequest = {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
};

export type TransportResponse = { status: number; body: Uint8Array };

/**
 * The one way this module talks to the network. Tests inject recorded responses; production passes the API gateway's
 * gateway.transportFor("heygen", organizationId) (src/engine/gateway), which is structurally the same type.
 */
export type RenderTransport = (request: TransportRequest) => Promise<TransportResponse>;

/**
 * Wraps a transport so that a network failure (the host cannot be reached, the request was aborted) becomes a retryable
 * provider error. A typed EngineError from the transport (the gateway's not-connected config error) passes through as it is.
 * The fallback policy counts provider errors as render failures, so a dropped connection moves the render on.
 */
export function guardTransport(transport: RenderTransport): RenderTransport {
  return async (request) => {
    try {
      return await transport(request);
    } catch (error) {
      if (error instanceof EngineError) throw error;
      const origin = request.url.split("/").slice(0, 3).join("/");
      throw new EngineError("provider", `${request.method} ${origin} did not complete: the request failed in transit`, {
        retryable: true,
        stage: "render",
        cause: error,
      });
    }
  };
}

// ---- the adapter interface ------------------------------------------------------------------------------------

/** What every renderer's submit input carries. The key is the same on a second submit, and that submit returns the same render. */
export type RenderSubmitBase = {
  /** Composition.contentHash for HyperFrames; the hash of the timeline for Shotstack. Also the ledger key. */
  idempotencyKey: string;
  title: string;
};

/** The HyperFrames payload: the zip of the composition and its assets. */
export type RenderSubmitInput = RenderSubmitBase & {
  archive: Uint8Array;
};

export type RenderSubmission = { renderId: string; status: string };

export type RenderStatus = {
  renderId: string;
  status: string;
  failureMessage?: string;
  videoUrl?: string;
  format?: string;
};

export type FetchedVideo = { bytes: Uint8Array };

/** Submit, poll and fetch. Each adapter is one renderer; the caller decides on fallbacks (Bible 6.11). */
export interface RenderAdapter<Input extends RenderSubmitBase = RenderSubmitInput> {
  readonly renderer: string;
  /** Throws a config error when the adapter cannot send a request (for example, no key). Runs before any budget hold. */
  ready(): Promise<void>;
  submit(input: Input): Promise<RenderSubmission>;
  poll(renderId: string): Promise<RenderStatus>;
  fetchResult(status: RenderStatus): Promise<FetchedVideo>;
}

export type HyperframesCloudOptions = {
  transport: RenderTransport;
  /** Returns the HeyGen key from Meridian's credential resolver, or null when none is usable. */
  credential: () => Promise<string | null>;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function providerError(stage: string, message: string, retryable: boolean): EngineError {
  return new EngineError("provider", message, { retryable, stage });
}

/** The error the cloud API returns: { error: { message, code } }, sometimes inside a { data } envelope. */
function describeFailure(response: TransportResponse): { message: string; code?: string } {
  let text = "";
  try {
    text = new TextDecoder().decode(response.body);
    const parsed = JSON.parse(text) as { error?: { message?: unknown; code?: unknown } };
    const message = typeof parsed.error?.message === "string" ? parsed.error.message : "";
    const code = typeof parsed.error?.code === "string" ? parsed.error.code : undefined;
    if (message) {
      return { message: message.slice(0, 300), code };
    }
  } catch {
    // Not JSON: fall through to the status line.
  }
  return { message: `HTTP ${response.status}${text ? "" : " with no body"}` };
}

/** Throws a typed error for a non-2xx response. Authentication failures are never retried; rate limits and 5xx are. */
function assertOk(stage: string, response: TransportResponse): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }
  const failure = describeFailure(response);
  if (response.status === 401 || response.status === 403) {
    throw providerError(stage, `${stage} was refused: authentication failed (HTTP ${response.status})`, false);
  }
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  throw providerError(stage, `${stage} failed (HTTP ${response.status}${failure.code ? `, ${failure.code}` : ""}): ${failure.message}`, retryable);
}

function parseJson(stage: string, response: TransportResponse): unknown {
  const text = new TextDecoder().decode(response.body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw providerError(stage, `${stage} returned a body that is not JSON`, true);
  }
  // The client unwraps a { data } envelope when it is present (cloud client request()).
  if (parsed && typeof parsed === "object" && "data" in parsed) {
    return (parsed as { data: unknown }).data;
  }
  return parsed;
}

const uploadSchema = z.object({
  asset_id: z.string().min(1),
  upload_url: z.string().min(1),
  upload_headers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullish(),
});

const renderSchema = z.object({
  render_id: z.string().min(1),
  status: z.string().min(1).nullish(),
});

const statusSchema = z.object({
  render_id: z.string().min(1).nullish(),
  status: z.string().min(1),
  video_url: z.string().min(1).nullish(),
  failure_message: z.string().nullish(),
  format: z.string().nullish(),
});

/** The HyperFrames cloud adapter over an injected transport. */
export class HyperframesCloudAdapter implements RenderAdapter {
  readonly renderer = HYPERFRAMES_CLOUD_RENDERER;
  private readonly transport: RenderTransport;
  private readonly credential: () => Promise<string | null>;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: HyperframesCloudOptions) {
    this.transport = guardTransport(options.transport);
    this.credential = options.credential;
    this.baseUrl = (options.baseUrl ?? HEYGEN_API_BASE_URL).replace(/\/+$/, "");
    this.sleep = options.sleep ?? defaultSleep;
  }

  async ready(): Promise<void> {
    await this.headers();
  }

  /** The key for one request. Null means no key: the caller must not send anything. */
  private async headers(): Promise<Record<string, string>> {
    const key = await this.credential();
    if (!key || key.trim().length === 0) {
      throw new EngineError("config", "no HeyGen key is available for HyperFrames rendering; no request was sent", {
        stage: "render",
      });
    }
    return { "x-api-key": key.trim(), [HEYGEN_CLIENT_SOURCE_HEADER]: HEYGEN_CLIENT_SOURCE };
  }

  async submit(input: RenderSubmitInput): Promise<RenderSubmission> {
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw new EngineError("invalid_input", "idempotency key must be 1 to 255 characters from [A-Za-z0-9_:.-]", {
        stage: "render",
      });
    }
    if (input.archive.byteLength > DIRECT_UPLOAD_LIMIT_BYTES) {
      throw new EngineError("invalid_input", "the composition archive is above the 200 MB direct-upload limit", {
        stage: "render",
      });
    }
    const auth = await this.headers();
    const assetId = await this.uploadArchive(input, auth);
    const response = await this.transport({
      method: "POST",
      url: `${this.baseUrl}/v3/hyperframes/renders`,
      headers: {
        ...auth,
        "content-type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        project: { type: "asset_id", asset_id: assetId },
        fps: RENDER_SETTINGS.fps,
        quality: RENDER_SETTINGS.quality,
        format: RENDER_SETTINGS.format,
        resolution: RENDER_SETTINGS.resolution,
        aspect_ratio: RENDER_SETTINGS.aspectRatio,
        title: input.title.slice(0, 120),
      }),
    });
    assertOk("render submit", response);
    const created = renderSchema.safeParse(parseJson("render submit", response));
    if (!created.success) {
      throw providerError("render submit", "render submit returned no render_id", true);
    }
    return { renderId: created.data.render_id, status: created.data.status ?? "queued" };
  }

  /** Direct upload: create the asset, PUT the bytes to the presigned URL, then complete it (retrying a 409). */
  private async uploadArchive(input: RenderSubmitInput, auth: Record<string, string>): Promise<string> {
    const checksum = sha256Hex(input.archive);
    const created = await this.transport({
      method: "POST",
      url: `${this.baseUrl}/v3/assets/direct-uploads`,
      headers: { ...auth, "content-type": "application/json", "Idempotency-Key": `${input.idempotencyKey}:upload` },
      body: JSON.stringify({
        filename: "composition.zip",
        content_type: "application/zip",
        size_bytes: input.archive.byteLength,
        checksum_sha256: checksum,
      }),
    });
    assertOk("upload start", created);
    const upload = uploadSchema.safeParse(parseJson("upload start", created));
    if (!upload.success) {
      throw providerError("upload start", "upload start returned no asset_id or upload_url", true);
    }

    // The presigned URL carries its own signature: the API key is never sent to it.
    const put = await this.transport({
      method: "PUT",
      url: upload.data.upload_url,
      headers: { "content-type": "application/zip", ...stringHeaders(upload.data.upload_headers) },
      body: input.archive,
    });
    if (put.status < 200 || put.status >= 300) {
      throw providerError("upload", `direct upload failed (HTTP ${put.status})`, put.status >= 500 || put.status === 429);
    }

    for (let attempt = 0; attempt < COMPLETE_MAX_RETRIES; attempt++) {
      const complete = await this.transport({
        method: "POST",
        url: `${this.baseUrl}/v3/assets/${encodeURIComponent(upload.data.asset_id)}/complete`,
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ checksum_sha256: checksum }),
      });
      if (complete.status === 409 && attempt < COMPLETE_MAX_RETRIES - 1) {
        await this.sleep(COMPLETE_RETRY_BASE_MS * (attempt + 1));
        continue;
      }
      assertOk("upload complete", complete);
      return upload.data.asset_id;
    }
    throw providerError("upload complete", "upload completion did not succeed after retries", true);
  }

  async poll(renderId: string): Promise<RenderStatus> {
    const auth = await this.headers();
    const response = await this.transport({
      method: "GET",
      url: `${this.baseUrl}/v3/hyperframes/renders/${encodeURIComponent(renderId)}`,
      headers: auth,
    });
    assertOk("render poll", response);
    const parsed = statusSchema.safeParse(parseJson("render poll", response));
    if (!parsed.success) {
      throw providerError("render poll", "render poll returned no status", true);
    }
    return {
      renderId,
      status: parsed.data.status,
      ...(parsed.data.failure_message ? { failureMessage: parsed.data.failure_message } : {}),
      ...(parsed.data.video_url ? { videoUrl: parsed.data.video_url } : {}),
      ...(parsed.data.format ? { format: parsed.data.format } : {}),
    };
  }

  async fetchResult(status: RenderStatus): Promise<FetchedVideo> {
    if (status.status !== "completed" || !status.videoUrl) {
      throw new EngineError("invalid_input", "only a completed render with a video_url can be fetched", { stage: "render" });
    }
    // The video URL is signed by the storage service. It gets no API key header.
    const response = await this.transport({ method: "GET", url: status.videoUrl, headers: {} });
    assertOk("video download", response);
    if (response.body.byteLength === 0) {
      throw providerError("video download", "video download returned no bytes", true);
    }
    return { bytes: response.body };
  }
}

function stringHeaders(headers: Record<string, string | number | boolean> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name] = String(value);
  }
  return out;
}

export function createHyperframesCloudAdapter(options: HyperframesCloudOptions): HyperframesCloudAdapter {
  return new HyperframesCloudAdapter(options);
}

// ---- budget, integrity and the render flow -------------------------------------------------------------------

export type IntegrityInput = {
  videoId: string;
  renderId: string;
  bytes: Uint8Array;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
};

export type StoreVideoInput = { videoId: string; bytes: Uint8Array; idempotencyKey: string };

export type RenderRequest = {
  requestId: string;
  reservationId: string;
  composition: Composition;
  /** The files compile() wrote, with their bytes. Checked against the composition before anything is sent. */
  files: CompiledFile[];
  /** The media the composition refers to. Their bytes come from resolveAsset at render time. */
  assets: CompiledAsset[];
  /** The EDL duration the video must match (within the configured tolerance, checked by the integrity hook). */
  durationMs: number;
  /** The render line of the reservation, in USD. The render price is not verified yet (prices.ts). */
  estimateUsd: number;
  /** ISO time of the call, used for the ledger entry and the monthly totals. */
  now: string;
  title?: string;
};

/** What the shared render flow needs from its caller, for any renderer (Bible 6.11, 14.1). */
export type RenderFlowDeps<Input extends RenderSubmitBase = RenderSubmitInput> = {
  adapter: RenderAdapter<Input>;
  ledger: LedgerStore;
  /** The render-integrity check (Bible 6.11, 12.3). It is injected: the probe and the rule come from eng-media-assets. */
  verifyIntegrity: (input: IntegrityInput) => Promise<GateResult>;
  /** Stores the finished video and returns its URI (Bible 5.2). */
  storeVideo: (input: StoreVideoInput) => Promise<string>;
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
  newVideoId?: () => string;
};

/** The HyperFrames flow: the flow's deps plus the resolver for the composition's media bytes. */
export type RenderDeps = RenderFlowDeps<RenderSubmitInput> & {
  /** Resolves a media URI to its bytes (Bible 5.2 storage). */
  resolveAsset: (uri: string) => Promise<Uint8Array>;
};

export type RenderOutcome = {
  video: RenderedVideo;
  renderId: string;
  /** Budget alerts raised while the hold was made (the cap mode refuses instead of alerting). */
  alerts: BudgetAlert[];
};

/** The composition's files and assets must be exactly what the hash covers, before a single byte is sent. */
function checkFilesMatch(composition: Composition, files: CompiledFile[]): void {
  const byPath = new Map(files.map((file) => [file.path, file]));
  if (byPath.size !== files.length) {
    throw new EngineError("invalid_input", "composition files contain a duplicate path", { stage: "render" });
  }
  if (files.length !== composition.files.length) {
    throw new EngineError("invalid_input", "composition files do not match the composition's file list", { stage: "render" });
  }
  for (const entry of composition.files) {
    const file = byPath.get(entry.path);
    if (!file) {
      throw new EngineError("invalid_input", `composition file ${entry.path} is missing`, { stage: "render" });
    }
    if (file.bytes.byteLength !== entry.bytes || contentHash(file.bytes) !== entry.contentHash) {
      throw new EngineError("invalid_input", `composition file ${entry.path} does not match its hash`, { stage: "render" });
    }
  }
  if (compositionHash(composition.files) !== composition.contentHash) {
    throw new EngineError("invalid_input", "composition contentHash does not match its files", { stage: "render" });
  }
}

/**
 * Render one composition on the cloud. The idempotency key is Composition.contentHash, so a retry or a resumed job
 * re-sends the same key: the provider returns the same render, and the ledger keeps one entry.
 * Throws EngineError for every refusal, failure and integrity miss. It never returns a video that did not pass.
 */
export async function renderComposition(request: RenderRequest, deps: RenderDeps): Promise<RenderOutcome> {
  const composition = compositionSchema.parse(request.composition);
  checkFilesMatch(composition, request.files);
  const key = composition.contentHash;
  const title = request.title ?? composition.edlId;
  return runRender(deps, {
    reservationId: request.reservationId,
    idempotencyKey: key,
    provider: HYPERFRAMES_LEDGER_PROVIDER,
    model: HYPERFRAMES_LEDGER_MODEL,
    edlId: composition.edlId,
    durationMs: request.durationMs,
    estimateUsd: request.estimateUsd,
    now: request.now,
    prepare: async () => {
      const assetFiles: CompiledFile[] = [];
      for (const asset of request.assets) {
        assetFiles.push({ path: asset.path, bytes: await deps.resolveAsset(asset.uri) });
      }
      const archive = buildZip([...request.files, ...assetFiles]);
      if (archive.byteLength > DIRECT_UPLOAD_LIMIT_BYTES) {
        throw new EngineError("invalid_input", "the composition with its assets is above the 200 MB direct-upload limit", {
          stage: "render",
        });
      }
      return { idempotencyKey: key, archive, title };
    },
  });
}

/** One render through the shared flow: what the ledger and the reservation need, and the renderer's payload builder. */
export type RenderFlow<Input extends RenderSubmitBase> = {
  reservationId: string;
  /** The idempotency key. It is also the ledger key, so it must be the same on every resubmit of the same render. */
  idempotencyKey: string;
  provider: string;
  model: string;
  edlId: string;
  durationMs: number;
  /** The render line of the reservation, in USD (an estimate until the reconciled actual is written). */
  estimateUsd: number;
  now: string;
  /** Builds the renderer's submit input. It runs after the budget hold, so a failure here keeps the hold, as it did before. */
  prepare: () => Promise<Input>;
};

/**
 * The render flow every renderer shares (Bible 6.11, 14.1): the budget hold (the ledger entry is written before the
 * call), the submit with the idempotency key, the poll, the download, the reconciliation, the integrity check and the
 * store. Every refusal, failure and integrity miss throws EngineError; nothing is stored unless the check passed.
 */
export async function runRender<Input extends RenderSubmitBase>(deps: RenderFlowDeps<Input>, flow: RenderFlow<Input>): Promise<RenderOutcome> {
  const key = flow.idempotencyKey;

  await deps.adapter.ready();
  const hold = await authorizeCall(deps.ledger, {
    reservationId: flow.reservationId,
    stage: "render",
    provider: flow.provider,
    model: flow.model,
    estimateUsd: flow.estimateUsd,
    idempotencyKey: key,
    at: flow.now,
  });
  if (hold.status === "refused") {
    throw new EngineError("conflict", `render refused by the budget: ${hold.reason}`, { stage: "render" });
  }
  if (hold.status === "duplicate" && !hold.samePayload) {
    throw new EngineError("conflict", `idempotency key ${key} was already used for a different render`, { stage: "render" });
  }
  // A render already on the ledger is never submitted again under its key. The provider may have billed it, and the key is not a confirmed
  // guarantee against a second bill (contract v6). An unsettled render waits for its bill or confirmation; a settled one is not re-billed.
  if (hold.status === "duplicate") {
    throw new EngineError(
      "conflict",
      hold.entry.settlement === undefined
        ? `render ${key} was submitted and its cost is unsettled, so it is not submitted again: settle it first`
        : `render ${key} was already submitted and billed, so it is not submitted again: reuse its stored video`,
      { stage: "render", retryable: false },
    );
  }

  const input = await flow.prepare();
  if (input.idempotencyKey !== key) {
    throw new EngineError("internal", "the submit input carries a different idempotency key from its ledger entry", {
      stage: "render",
    });
  }
  const submission = await deps.adapter.submit(input);
  const status = await pollUntilDone(deps, submission.renderId);

  if (status.status === "failed") {
    // The provider may or may not have billed the failed render, and says nothing about which. The call stays unsettled, and it is not
    // submitted again under its key (the duplicate check above).
    throw new EngineError(
      "provider",
      `render ${submission.renderId} failed at the provider, and its cost is unsettled: ${status.failureMessage ?? "no failure message was returned"}`,
      { retryable: false, stage: "render" },
    );
  }

  const fetched = await deps.adapter.fetchResult(status);
  // The render has no bill from its provider (render/STATUS.md), so the call stays unsettled and its cost is unknown. No estimate is booked.
  const reconciled = await reconcileCall(deps.ledger, { idempotencyKey: key });
  const costUsd = reconciled.entry.actualUsd ?? null;

  const videoId = deps.newVideoId?.() ?? newId("vid_");
  const gate = gateResultSchema.parse(
    await deps.verifyIntegrity({
      videoId,
      renderId: submission.renderId,
      bytes: fetched.bytes,
      durationMs: flow.durationMs,
      width: RENDER_EXPECTATION.width,
      height: RENDER_EXPECTATION.height,
      fps: RENDER_EXPECTATION.fps,
    }),
  );
  if (gate.gate !== "render_integrity" || gate.subjectId !== videoId || !gate.pass || !allChecksPass(gate.checks)) {
    const failing = gate.checks.filter((check) => !check.pass).map((check) => check.rule);
    throw new EngineError(
      "provider",
      `render ${submission.renderId} failed the render-integrity check: ${failing.join(", ") || "no checks ran"}`,
      { retryable: false, stage: "render_integrity" },
    );
  }

  const uri = await deps.storeVideo({ videoId, bytes: fetched.bytes, idempotencyKey: key });
  const video = renderedVideoSchema.parse({
    videoId,
    edlId: flow.edlId,
    uri,
    renderer: deps.adapter.renderer,
    durationMs: flow.durationMs,
    bytes: fetched.bytes.byteLength,
    estimateUsd: flow.estimateUsd,
    costUsd,
    idempotencyKey: key,
  });
  return {
    video,
    renderId: submission.renderId,
    alerts: hold.status === "authorized" ? hold.alerts : [],
  };
}

async function pollUntilDone<Input extends RenderSubmitBase>(deps: RenderFlowDeps<Input>, renderId: string): Promise<RenderStatus> {
  const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPolls = deps.maxPolls ?? DEFAULT_MAX_POLLS;
  const sleep = deps.sleep ?? defaultSleep;
  for (let poll = 0; poll < maxPolls; poll++) {
    const status = await deps.adapter.poll(renderId);
    if (status.status === "completed" || status.status === "failed") {
      if (status.status === "completed" && !status.videoUrl) {
        throw providerError("render poll", `render ${renderId} completed without a video_url`, true);
      }
      return status;
    }
    await sleep(interval);
  }
  throw providerError("render poll", `render ${renderId} did not finish after ${maxPolls} polls; resume with the same key`, true);
}
