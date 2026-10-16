// Shotstack fallback render (Bible 6.11 and 9.3; owner decision 2026-10-14: Shotstack is the only fallback, and Remotion
// Lambda is dropped). It renders component-free EDLs only: media, audio and plain text. An EDL that uses a custom
// component is refused with a typed error, and the caller sends it to review.
//
//   - assertComponentFree / isComponentFree: the refusal (Bible 6.11 as amended).
//   - toShotstackTimeline: a pure mapper from an EDL to the POST /render body: tracks of clips, 1080 x 1920, 30 fps, mp4.
//   - ShotstackAdapter: the RenderAdapter for Shotstack. Its HTTP calls go through an injected transport. In production
//     that transport is gateway.transportFor("shotstack", organizationId), which attaches the key to requests on the
//     provider host and sends the signed download URL with no key. This module never holds or reads a key.
//   - renderEdlWithShotstack: the same budget hold, idempotency, poll, download, integrity check and store as HyperFrames
//     (runRender in hyperframesCloud.ts).
//
// The API shape is in docs/engine/PROVIDER_APIS.md (section "Shotstack"). A field that section does not name carries the
// marker `verify against Shotstack docs`, and render/STATUS.md lists every one of them.

import { z } from "zod";
import { contentHash, EDL_LAYERS, EngineError, edlSchema, type EdlClip, type EdlLayer, type EditDecisionList } from "../contracts/index.ts";
import {
  guardTransport,
  runRender,
  type FetchedVideo,
  type RenderAdapter,
  type RenderFlowDeps,
  type RenderOutcome,
  type RenderStatus,
  type RenderSubmission,
  type RenderSubmitBase,
  type RenderTransport,
  type TransportResponse,
} from "./hyperframesCloud.ts";

export const SHOTSTACK_RENDERER = "shotstack";
/** The ledger's provider and model for a Shotstack render: the render.fallback route in config/routes.ts. */
export const SHOTSTACK_LEDGER_PROVIDER = "shotstack";
export const SHOTSTACK_LEDGER_MODEL = "edit-v1";
/** The production environment (the docs' {version} is v1; the sandbox is `stage`). The gateway's provider entry has the same base. */
export const SHOTSTACK_BASE_URL = "https://api.shotstack.io/edit/v1";
/** The background behind the clips (the docs' example colour). */
export const SHOTSTACK_BACKGROUND = "#000000";
/** Title style and colour. The docs name the fields but not these values. */
const TITLE_STYLE = "minimal"; // verify against Shotstack docs
const TITLE_COLOR = "#ffffff"; // verify against Shotstack docs
/** The header that carries the idempotency key. The docs do not name one: see render/STATUS.md before the live run. */
const IDEMPOTENCY_HEADER = "Idempotency-Key"; // verify against Shotstack docs
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_:.-]{1,255}$/;
const MEDIA_KINDS: Readonly<Record<string, "video" | "image">> = {
  mp4: "video",
  webm: "video",
  mov: "video",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
};

// ---- the timeline ----------------------------------------------------------------------------------------------------

export type ShotstackAsset =
  | { type: "video"; src: string; trim: number; volume: number } // trim units (seconds) and volume 0 = muted: verify against Shotstack docs
  | { type: "image"; src: string }
  | { type: "title"; text: string; style: string; color: string } // color is not named in the docs: verify against Shotstack docs
  | { type: "audio"; src: string; volume: number }; // the docs name only the type; src and volume: verify against Shotstack docs

export type ShotstackClip = {
  asset: ShotstackAsset;
  /** Seconds on the timeline. */
  start: number;
  /** Seconds. */
  length: number;
  fit?: "cover";
  position?: "center";
  /** The EDL clip id, so a picture clip in the timeline traces back to its EDL clip (the docs' `alias`). */
  alias?: string;
};

export type ShotstackTimeline = { background: string; tracks: { clips: ShotstackClip[] }[] };

export type ShotstackOutput = { format: "mp4"; size: { width: number; height: number }; fps: number };

/** The POST /render body. */
export type ShotstackRenderBody = { timeline: ShotstackTimeline; output: ShotstackOutput };

/** The mapped body, and the EDL features Shotstack cannot draw (the caller records them in the manifest). */
export type ShotstackMapping = ShotstackRenderBody & { dropped: string[] };

// ---- the refusal -----------------------------------------------------------------------------------------------------

/** The EDL uses a custom component, which Shotstack cannot draw. Bible 6.11: the EDL goes to review. */
export class ShotstackRefusal extends EngineError {
  readonly review = true;
  readonly components: string[];

  constructor(components: string[]) {
    super(
      "invalid_input",
      `the EDL uses custom components (${components.join(", ")}); Shotstack renders component-free EDLs only, so the EDL goes to review`,
      { retryable: false, stage: "render" },
    );
    this.name = "ShotstackRefusal";
    this.components = components;
  }
}

/** The custom components an EDL uses, sorted and without repeats. */
export function componentsUsedBy(edl: EditDecisionList): string[] {
  const names = new Set<string>();
  for (const track of edl.tracks) {
    for (const clip of track.clips) {
      if (clip.component !== undefined) names.add(clip.component);
    }
  }
  return [...names].sort();
}

/** True only when the EDL uses no custom component (Bible 6.11). */
export function isComponentFree(edl: EditDecisionList): boolean {
  return componentsUsedBy(edl).length === 0;
}

/** Throws ShotstackRefusal when the EDL uses a custom component. */
export function assertComponentFree(edl: EditDecisionList): void {
  const names = componentsUsedBy(edl);
  if (names.length > 0) throw new ShotstackRefusal(names);
}

/** Every media and audio URI the EDL refers to, sorted and without repeats. Each needs a fetchable URL before a render. */
export function sourceUrisOf(edl: EditDecisionList): string[] {
  const uris = new Set<string>();
  for (const track of edl.tracks) {
    for (const clip of track.clips) {
      if (clip.srcUri !== undefined) uris.add(clip.srcUri);
    }
  }
  uris.add(edl.audio.voice.uri);
  if (edl.audio.music) uris.add(edl.audio.music.uri);
  for (const sfx of edl.audio.sfx) uris.add(sfx.uri);
  return [...uris].sort();
}

// ---- the mapper ------------------------------------------------------------------------------------------------------

/** Shotstack draws earlier tracks on top of later ones, so the picture tracks run front first (the EDL stacks back to front). */
const FRONT_FIRST: readonly EdlLayer[] = [...EDL_LAYERS].reverse();

const seconds = (ms: number): number => ms / 1000;
const volumeOf = (gainDb: number): number => 10 ** (gainDb / 20);

function mediaKindOf(uri: string): "video" | "image" {
  const path = uri.split("?")[0] ?? uri;
  const extension = (path.split(".").pop() ?? "").toLowerCase();
  const kind = MEDIA_KINDS[extension];
  if (kind === undefined) {
    throw new EngineError("invalid_input", `Shotstack cannot draw ${uri}: it needs a video or an image`, { stage: "render" });
  }
  return kind;
}

/** The clips of one picture layer, in time order. Two clips on one layer that overlap cannot share a Shotstack track here. */
function clipsOfLayer(edl: EditDecisionList, layer: EdlLayer): EdlClip[] {
  const clips = edl.tracks
    .filter((track) => track.layer === layer)
    .flatMap((track) => track.clips)
    .sort((a, b) => a.startMs - b.startMs || (a.clipId < b.clipId ? -1 : a.clipId > b.clipId ? 1 : 0));
  for (let index = 1; index < clips.length; index++) {
    const previous = clips[index - 1] as EdlClip;
    const current = clips[index] as EdlClip;
    if (current.startMs < previous.endMs) {
      throw new EngineError("invalid_input", `clips ${previous.clipId} and ${current.clipId} overlap on the ${layer} layer`, {
        stage: "render",
      });
    }
  }
  return clips;
}

function pictureClip(clip: EdlClip, sourceUrl: (uri: string) => string, dropped: string[]): ShotstackClip {
  if (clip.transitionIn !== undefined) dropped.push(`transition ${clip.transitionIn} on ${clip.clipId} is not mapped`);
  if (clip.box !== undefined) dropped.push(`box on ${clip.clipId} is not mapped (picture-in-picture)`);
  const start = seconds(clip.startMs);
  const length = seconds(clip.endMs - clip.startMs);
  if (clip.srcUri !== undefined) {
    const kind = mediaKindOf(clip.srcUri);
    const src = sourceUrl(clip.srcUri);
    const asset: ShotstackAsset =
      kind === "video" ? { type: "video", src, trim: seconds(clip.srcInMs ?? 0), volume: 0 } : { type: "image", src };
    return { asset, start, length, fit: "cover", alias: clip.clipId };
  }
  const text = clip.props?.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new EngineError("invalid_input", `clip ${clip.clipId} has neither a media source nor text, so Shotstack cannot draw it`, {
      stage: "render",
    });
  }
  return {
    asset: { type: "title", text, style: TITLE_STYLE, color: TITLE_COLOR },
    start,
    length,
    position: "center",
    alias: clip.clipId,
  };
}

function audioClip(clip: { uri: string; startMs: number; endMs: number; gainDb: number }, sourceUrl: (uri: string) => string): ShotstackClip {
  return {
    asset: { type: "audio", src: sourceUrl(clip.uri), volume: volumeOf(clip.gainDb) },
    start: seconds(clip.startMs),
    length: seconds(clip.endMs - clip.startMs),
  };
}

/**
 * Maps a component-free EDL to the POST /render body (Bible 6.11, 9.3). Pure: the same EDL and URLs give the same body.
 *
 * `sourceUrl` gives the URL Shotstack fetches for each EDL URI. The adapter passes signed, temporary https URLs. The
 * idempotency key is computed from the EDL's own URIs (shotstackRenderKey), so a re-signed URL does not change the key.
 *
 * Shotstack does not draw what the EDL asks for in these cases. They are not drawn, and each one is listed in `dropped`:
 * effects, transitions, and picture-in-picture boxes (the effect and transition names are not verified). The music stem
 * is already ducked upstream (Bible 9.1 rule 5), so the mapper uses only its gain. Loudness is not set by Shotstack.
 */
export function toShotstackTimeline(edl: EditDecisionList, sourceUrl: (uri: string) => string): ShotstackMapping {
  const parsed = edlSchema.safeParse(edl);
  if (!parsed.success) {
    throw new EngineError("invalid_input", `the EDL is invalid: ${parsed.error.message}`, { stage: "render" });
  }
  const valid = parsed.data;
  assertComponentFree(valid);

  const dropped: string[] = [];
  const tracks: { clips: ShotstackClip[] }[] = [];

  for (const layer of FRONT_FIRST) {
    const clips = clipsOfLayer(valid, layer);
    if (clips.length === 0) continue;
    tracks.push({ clips: clips.map((clip) => pictureClip(clip, sourceUrl, dropped)) });
  }

  // The voice and the music each get a track. Sound effects share the fewest tracks that do not overlap, in start order.
  tracks.push({ clips: [audioClip(valid.audio.voice, sourceUrl)] });
  if (valid.audio.music) tracks.push({ clips: [audioClip(valid.audio.music, sourceUrl)] });
  const effectTracks: { endMs: number; clips: ShotstackClip[] }[] = [];
  for (const sfx of [...valid.audio.sfx].sort((a, b) => a.startMs - b.startMs)) {
    const clip = audioClip(sfx, sourceUrl);
    const slot = effectTracks.find((candidate) => candidate.endMs <= sfx.startMs);
    if (slot) {
      slot.clips.push(clip);
      slot.endMs = sfx.endMs;
    } else {
      effectTracks.push({ endMs: sfx.endMs, clips: [clip] });
    }
  }
  for (const sfxTrack of effectTracks) tracks.push({ clips: sfxTrack.clips });

  for (const effect of valid.effects) {
    dropped.push(`effect ${effect.kind} at ${effect.atMs} ms is not mapped`);
  }

  return {
    timeline: { background: SHOTSTACK_BACKGROUND, tracks },
    output: { format: "mp4", size: { width: valid.width, height: valid.height }, fps: valid.fps },
    dropped,
  };
}

/**
 * The idempotency key of a Shotstack render: the hash of its timeline and output, built from the EDL's own URIs. A
 * resubmit of the same EDL has the same key even when its signed source URLs have changed.
 */
export function shotstackRenderKey(edl: EditDecisionList): string {
  const { timeline, output } = toShotstackTimeline(edl, (uri) => uri);
  return contentHash({ timeline, output });
}

// ---- the adapter -----------------------------------------------------------------------------------------------------

export type ShotstackSubmitInput = RenderSubmitBase & { body: ShotstackRenderBody };

export type ShotstackAdapterOptions = {
  /** gateway.transportFor("shotstack", organizationId): authenticated on the provider host, unauthenticated elsewhere. */
  transport: RenderTransport;
  /** gateway.connection("shotstack", organizationId): whether Shotstack is connected for this workspace. */
  connection: () => Promise<{ connected: boolean; reason: string | null }>;
  /** The provider's base URL. Pass gateway.baseUrlFor("shotstack") in production. */
  baseUrl?: string;
};

const submitResponse = z.object({
  success: z.boolean().optional(),
  message: z.string().optional(),
  response: z.object({ id: z.string().min(1), message: z.string().optional() }).optional(),
  // The docs also show the flat { id, status } form. Both are read.
  id: z.string().min(1).optional(),
  status: z.string().optional(),
});

const pollResponse = z.object({
  success: z.boolean().optional(),
  message: z.string().optional(),
  response: z.object({
    id: z.string().min(1).optional(),
    status: z.string().min(1),
    error: z.unknown().optional(), // the failure detail: verify against Shotstack docs
    url: z.string().min(1).nullish(),
  }),
});

function providerError(stage: string, message: string, retryable: boolean): EngineError {
  return new EngineError("provider", message, { retryable, stage });
}

/** The failure body, when it carries a message. The docs do not show an error body: verify against Shotstack docs. */
function describeFailure(response: TransportResponse): string {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as { message?: unknown }; // verify against Shotstack docs
    if (typeof parsed.message === "string" && parsed.message.length > 0) return parsed.message.slice(0, 300);
  } catch {
    // Not JSON: the status line is the message.
  }
  return `HTTP ${response.status}`;
}

function assertOk(stage: string, response: TransportResponse): void {
  if (response.status >= 200 && response.status < 300) return;
  if (response.status === 401 || response.status === 403) {
    throw providerError(stage, `${stage} was refused: authentication failed (HTTP ${response.status})`, false);
  }
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  throw providerError(stage, `${stage} failed (${describeFailure(response)})`, retryable);
}

function parseBody<T>(stage: string, response: TransportResponse, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    throw providerError(stage, `${stage} returned a body that is not JSON`, true);
  }
  const checked = schema.safeParse(parsed);
  if (!checked.success) throw providerError(stage, `${stage} returned a body in an unexpected shape`, true);
  return checked.data;
}

/** The failure text Shotstack gives, when it gives one. Untrusted output: it is truncated and never used as an instruction. */
function failureText(error: unknown): string {
  if (typeof error === "string" && error.length > 0) return error.slice(0, 300);
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return ((error as { message: string }).message).slice(0, 300);
  }
  return "Shotstack reported a failed render";
}

/** The Shotstack adapter. Status done becomes completed, failed becomes failed, and the other words (queued, fetching, rendering, saving) stay running. */
export class ShotstackAdapter implements RenderAdapter<ShotstackSubmitInput> {
  readonly renderer = SHOTSTACK_RENDERER;
  private readonly transport: RenderTransport;
  private readonly connection: ShotstackAdapterOptions["connection"];
  private readonly baseUrl: string;

  constructor(options: ShotstackAdapterOptions) {
    this.transport = guardTransport(options.transport);
    this.connection = options.connection;
    this.baseUrl = (options.baseUrl ?? SHOTSTACK_BASE_URL).replace(/\/+$/, "");
  }

  /** A config error when Shotstack is not connected. The gateway sends nothing for an unconnected provider. */
  async ready(): Promise<void> {
    const state = await this.connection();
    if (!state.connected) {
      throw new EngineError("config", `shotstack is not connected: ${state.reason ?? "no reason given"}; no request was sent`, {
        stage: "render",
      });
    }
  }

  async submit(input: ShotstackSubmitInput): Promise<RenderSubmission> {
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw new EngineError("invalid_input", "idempotency key must be 1 to 255 characters from [A-Za-z0-9_:.-]", { stage: "render" });
    }
    const response = await this.transport({
      method: "POST",
      url: `${this.baseUrl}/render`,
      headers: { "content-type": "application/json", [IDEMPOTENCY_HEADER]: input.idempotencyKey },
      body: JSON.stringify(input.body),
    });
    assertOk("render submit", response);
    const created = parseBody("render submit", response, submitResponse);
    if (created.success === false) {
      throw providerError("render submit", `render submit was not accepted: ${created.message ?? "no message"}`, false);
    }
    const renderId = created.response?.id ?? created.id;
    if (renderId === undefined) throw providerError("render submit", "render submit returned no render id", true);
    return { renderId, status: "queued" };
  }

  async poll(renderId: string): Promise<RenderStatus> {
    const response = await this.transport({
      method: "GET",
      url: `${this.baseUrl}/render/${encodeURIComponent(renderId)}`,
      headers: {},
    });
    assertOk("render poll", response);
    const body = parseBody("render poll", response, pollResponse);
    const { status, error, url } = body.response;
    if (status === "done") {
      return { renderId, status: "completed", ...(url ? { videoUrl: url } : {}) };
    }
    if (status === "failed") {
      return { renderId, status: "failed", failureMessage: failureText(error) };
    }
    return { renderId, status };
  }

  async fetchResult(status: RenderStatus): Promise<FetchedVideo> {
    if (status.status !== "completed" || !status.videoUrl) {
      throw new EngineError("invalid_input", "only a completed render with a url can be fetched", { stage: "render" });
    }
    // The url is a temporary, signed asset URL from the provider's response. It is data: it must be https, and it gets no key.
    if (!status.videoUrl.startsWith("https://")) {
      throw providerError("video download", "the render's url is not https, so it was not fetched", false);
    }
    const response = await this.transport({ method: "GET", url: status.videoUrl, headers: {} });
    assertOk("video download", response);
    if (response.body.byteLength === 0) throw providerError("video download", "video download returned no bytes", true);
    return { bytes: response.body };
  }
}

export function createShotstackAdapter(options: ShotstackAdapterOptions): ShotstackAdapter {
  return new ShotstackAdapter(options);
}

// ---- the render -------------------------------------------------------------------------------------------------------

export type ShotstackRenderRequest = {
  reservationId: string;
  edl: EditDecisionList;
  /** The render line of the reservation, in USD. The render price is an estimate until the ledger reconciles it. */
  estimateUsd: number;
  /** ISO time of the call. */
  now: string;
  /** Not sent to Shotstack (its request body has no title field). It is for logs. */
  title?: string;
};

export type ShotstackDeps = RenderFlowDeps<ShotstackSubmitInput> & {
  /** A URL Shotstack can fetch for a media URI: a signed, temporary https URL from storage (Bible 5.2). */
  resolveSourceUrl: (uri: string) => Promise<string>;
};

export type ShotstackRenderOutcome = RenderOutcome & { dropped: string[] };

/**
 * Renders a component-free EDL on Shotstack through the shared render flow: the budget hold, the POST /render with the
 * key, the poll, the download, the reconciliation, the integrity check and the store. A custom component throws
 * ShotstackRefusal before any request is made.
 */
export async function renderEdlWithShotstack(request: ShotstackRenderRequest, deps: ShotstackDeps): Promise<ShotstackRenderOutcome> {
  const parsed = edlSchema.safeParse(request.edl);
  if (!parsed.success) {
    throw new EngineError("invalid_input", `the EDL is invalid: ${parsed.error.message}`, { stage: "render" });
  }
  const edl = parsed.data;
  assertComponentFree(edl);

  const key = shotstackRenderKey(edl);
  const urls = new Map<string, string>();
  for (const uri of sourceUrisOf(edl)) {
    const url = await deps.resolveSourceUrl(uri);
    if (!url.startsWith("https://")) {
      throw new EngineError("invalid_input", `the source URL for ${uri} is not https; Shotstack needs a URL it can fetch`, {
        stage: "render",
      });
    }
    urls.set(uri, url);
  }
  const sourceUrl = (uri: string): string => {
    const url = urls.get(uri);
    if (url === undefined) throw new EngineError("internal", `no source URL was resolved for ${uri}`, { stage: "render" });
    return url;
  };
  const mapping = toShotstackTimeline(edl, sourceUrl);
  const title = request.title ?? edl.edlId;

  const outcome = await runRender(deps, {
    reservationId: request.reservationId,
    idempotencyKey: key,
    provider: SHOTSTACK_LEDGER_PROVIDER,
    model: SHOTSTACK_LEDGER_MODEL,
    edlId: edl.edlId,
    durationMs: edl.durationMs,
    estimateUsd: request.estimateUsd,
    now: request.now,
    prepare: async () => ({ idempotencyKey: key, title, body: { timeline: mapping.timeline, output: mapping.output } }),
  });
  return { ...outcome, dropped: mapping.dropped };
}
