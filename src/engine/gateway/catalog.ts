// OpenRouter's model catalog (Bible 10.5 step 1, contract v7): the candidates the orchestrator may choose a production model from.
// Three free listings, read through the gateway (which adds the key; nothing here calls fetch):
//
//   GET /videos/models                       video classes. Prices per SKU in `pricing_skus`.
//   GET /models?output_modalities=image      image classes. `pricing` fields are decimal strings.
//   GET /models?output_modalities=speech     speech (tts). Same shape.
//
// The listings are untrusted data. Each row is parsed with zod; a row that does not parse, cannot be mapped to a model class, or
// has no price the engine can estimate a call from is dropped with its reason, never guessed. What is kept is a ModelCatalogEntry
// (contracts/catalog.ts), which cannot represent a model without a positive price.
//
// UNVERIFIED LIVE. PROVIDER_APIS.md lists the fields of GET /videos/models but not the keys of `pricing_skus`, and the fields of
// GET /models beyond `pricing` and `architecture` are taken from OpenRouter's models guide. The SKU names below
// (VIDEO_SECOND_SKUS) and the image and speech price fields come from the lead's brief of 2026-10-16. The recorded fixtures in
// gateway/test/fixtures/ are written from that documented shape, not from a live answer. The owner's live run confirms them.
//
// Mapping (fail closed):
// - A video model serves video.cinematic and video.budget. It is never a video.i2v_pinned candidate: that class takes only models
//   that passed the first-and-last-frame test (Bible 10.3, 20.3 item 2), which a listing cannot show. Avatar has no marker in the
//   listing, so no listed model is an avatar candidate.
// - An image model serves image.keyframe; it also serves image.edit when the listing says it takes an image as input.
// - A speech model serves tts.
// - A capability the listing does not state is null, and the eligibility filter (catalog-fit.ts) refuses a need that depends on it.
//
// Cache: one read per workspace is kept for adapters.catalog.ttlMs, with its read time. A read with a failed listing is returned
// but not kept, so the next call reads again. Concurrent calls for one workspace share one read.

import { z } from "zod";
import { adapters } from "../config/adapters.ts";
import { RETIRED_MODEL_IDS } from "../config/retired-models.ts";
import { EngineError } from "../contracts/errors.ts";
import { modelCatalogEntrySchema, type CatalogCapabilities, type CatalogPrice, type ModelCatalogEntry } from "../contracts/catalog.ts";
import type { ModelClass } from "../contracts/plan.ts";
import { httpError, jsonBody } from "./errors.ts";
import type { Gateway } from "./gateway.ts";

const PROVIDER = "openrouter";

/** The three listings the catalog is read from. */
export const CATALOG_SOURCES = ["videos", "image", "speech"] as const;
export type CatalogSource = (typeof CATALOG_SOURCES)[number];

const SOURCE_PATHS: Record<CatalogSource, string> = {
  videos: "/videos/models",
  image: "/models?output_modalities=image",
  speech: "/models?output_modalities=speech",
};

/** The resolution the engine renders video at (Bible section 1), so the per-second SKU priced for it is preferred. */
export const CATALOG_VIDEO_RESOLUTION = "1080p";

/**
 * The per-second SKUs of `pricing_skus` the engine estimates a video call from, best first: the one priced for the engine's
 * resolution, then the general one. UNVERIFIED LIVE (see the file header). A model with neither is not a candidate.
 */
export const VIDEO_SECOND_SKUS = [`per-video-second-${CATALOG_VIDEO_RESOLUTION}`, "per-video-second"] as const;

/** The classes a listed video model serves. video.i2v_pinned is left out on purpose (see the file header). */
export const CATALOG_VIDEO_CLASSES = ["video.cinematic", "video.budget"] as const satisfies readonly ModelClass[];

/** A row the catalog left out, and why. The reason is the engine's own text; the id is the listing's, as data. */
export type CatalogDrop = { source: CatalogSource; id: string | null; reason: string };

/** A listing that could not be read. Its models are not candidates in this read. */
export type CatalogFailure = { source: CatalogSource; reason: string };

export type ModelCatalog = {
  /** When the listings were read (ISO). Every entry carries it as its readAt. */
  readAt: string;
  entries: ModelCatalogEntry[];
  dropped: CatalogDrop[];
  failed: CatalogFailure[];
  /**
   * The parsed body of GET /videos/models, kept so that the asset router can build the video adapters' profiles from the same read
   * (assets/providers/openrouterVideo.ts videoProfilesFromListing) without a second request. Null when that listing failed.
   */
  videoListing: unknown;
};

export type CatalogRead = { status: "read"; catalog: ModelCatalog } | { status: "not_connected"; reason: string };

/** Where the router and the orchestrator get the catalog from. */
export interface ModelCatalogSource {
  read(organizationId: string): Promise<CatalogRead>;
}

// ---- parsing ------------------------------------------------------------------------------------------------------------

/** A decimal price as the listings write it ("0.126", 0.126). Anything else is not a price. */
function priceValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d+(\.\d+)?([eE]-?\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A usable rate: finite and positive. Zero (free) and the listings' -1 (variable) are not rates the engine can reserve against. */
function usableRate(value: unknown): number | null {
  const parsed = priceValue(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function idOf(raw: unknown): string | null {
  const id = typeof raw === "object" && raw !== null ? (raw as { id?: unknown }).id : undefined;
  return typeof id === "string" && id.length > 0 && id.length <= 200 ? id : null;
}

const listingSchema = z.looseObject({ data: z.array(z.unknown()) });

const videoRowSchema = z.looseObject({
  id: z.string().min(1).max(200),
  generate_audio: z.boolean().optional(),
  supported_durations: z.array(z.number().finite().positive()).optional(),
  supported_resolutions: z.array(z.string().min(1)).optional(),
  supported_aspect_ratios: z.array(z.string().min(1)).optional(),
  supported_frame_images: z.array(z.string()).optional(),
  pricing_skus: z.unknown().optional(),
});

const modelRowSchema = z.looseObject({
  id: z.string().min(1).max(200),
  architecture: z
    .looseObject({
      input_modalities: z.array(z.string()).optional(),
      output_modalities: z.array(z.string()).optional(),
    })
    .optional(),
  pricing: z.record(z.string(), z.unknown()).optional(),
});

type Parsed = { entries: ModelCatalogEntry[]; dropped: CatalogDrop[] };

/** Checks a built entry against the contract. An entry that fails is dropped with the first issue's path. */
function keep(out: Parsed, source: CatalogSource, entry: ModelCatalogEntry): void {
  const checked = modelCatalogEntrySchema.safeParse(entry);
  if (checked.success) {
    out.entries.push(checked.data);
    return;
  }
  const issue = checked.error.issues[0];
  out.dropped.push({ source, id: entry.id, reason: `the entry does not fit the catalog contract (${issue ? issue.path.join(".") || "entry" : "entry"})` });
}

/** The per-second price of a video row, from its pricing_skus, or the reason it has none. */
function videoPrice(skus: unknown): CatalogPrice | string {
  if (skus === undefined) return "no pricing_skus, so a call could not be reserved";
  if (typeof skus !== "object" || skus === null || Array.isArray(skus)) return "pricing_skus is not an object of SKU to price";
  const table = skus as Record<string, unknown>;
  for (const sku of VIDEO_SECOND_SKUS) {
    const rate = usableRate(table[sku]);
    if (rate !== null) return { unit: "per_second", usd: rate, sku };
  }
  return `no positive per-second price (${VIDEO_SECOND_SKUS.join(" or ")}), so a call could not be reserved`;
}

/** Parses GET /videos/models. Pure. */
export function parseVideoCatalog(body: unknown, readAt: string): Parsed {
  const out: Parsed = { entries: [], dropped: [] };
  const listing = listingSchema.safeParse(body);
  if (!listing.success) {
    out.dropped.push({ source: "videos", id: null, reason: "the listing has no data array" });
    return out;
  }
  for (const raw of listing.data.data) {
    const row = videoRowSchema.safeParse(raw);
    if (!row.success) {
      out.dropped.push({ source: "videos", id: idOf(raw), reason: "the row does not match the listing shape" });
      continue;
    }
    const model = row.data;
    const retired = RETIRED_MODEL_IDS[model.id];
    if (retired !== undefined) {
      out.dropped.push({ source: "videos", id: model.id, reason: retired });
      continue;
    }
    const price = videoPrice(model.pricing_skus);
    if (typeof price === "string") {
      out.dropped.push({ source: "videos", id: model.id, reason: price });
      continue;
    }
    const durations = [...(model.supported_durations ?? [])].sort((a, b) => a - b);
    const frames = model.supported_frame_images;
    const capabilities: CatalogCapabilities = {
      minSeconds: durations.length > 0 ? (durations[0] as number) : null,
      maxSeconds: durations.length > 0 ? (durations[durations.length - 1] as number) : null,
      aspectRatios: model.supported_aspect_ratios ?? null,
      resolutions: model.supported_resolutions ?? null,
      firstFrame: frames === undefined ? null : frames.includes("first_frame"),
      lastFrame: frames === undefined ? null : frames.includes("last_frame"),
      // The listing does not say how many reference images a video model takes.
      refsMax: null,
      audio: model.generate_audio ?? null,
    };
    keep(out, "videos", { id: model.id, modelClasses: [...CATALOG_VIDEO_CLASSES], capabilities, price, readAt });
  }
  return out;
}

/** The price of an image or speech row, from its pricing strings, or the reason it has none. Token rates are not usable. */
function listedPrice(source: "image" | "speech", pricing: Record<string, unknown> | undefined): CatalogPrice | string {
  if (pricing === undefined) return "no pricing, so a call could not be reserved";
  if (source === "image") {
    const perImage = usableRate(pricing.image_output);
    if (perImage !== null) return { unit: "per_image", usd: perImage, sku: "image_output" };
  }
  const perRequest = usableRate(pricing.request);
  if (perRequest !== null) return { unit: "per_request", usd: perRequest, sku: "request" };
  if (usableRate(pricing.prompt) !== null || usableRate(pricing.completion) !== null) {
    return "priced per token only; the engine cannot know a call's tokens before it is made, so it could not be reserved";
  }
  return "no positive price, so a call could not be reserved";
}

/** The output modality each /models listing was asked for. A row that names its outputs must include it. */
const OUTPUT_MODALITY: Record<"image" | "speech", string> = { image: "image", speech: "speech" };

/** Parses GET /models?output_modalities=image or =speech. Pure. */
export function parseModelsCatalog(source: "image" | "speech", body: unknown, readAt: string): Parsed {
  const out: Parsed = { entries: [], dropped: [] };
  const listing = listingSchema.safeParse(body);
  if (!listing.success) {
    out.dropped.push({ source, id: null, reason: "the listing has no data array" });
    return out;
  }
  for (const raw of listing.data.data) {
    const row = modelRowSchema.safeParse(raw);
    if (!row.success) {
      out.dropped.push({ source, id: idOf(raw), reason: "the row does not match the listing shape" });
      continue;
    }
    const model = row.data;
    const outputs = model.architecture?.output_modalities;
    if (outputs !== undefined && !outputs.includes(OUTPUT_MODALITY[source])) {
      out.dropped.push({ source, id: model.id, reason: `the row does not list ${OUTPUT_MODALITY[source]} as an output` });
      continue;
    }
    const price = listedPrice(source, model.pricing);
    if (typeof price === "string") {
      out.dropped.push({ source, id: model.id, reason: price });
      continue;
    }
    const inputs = model.architecture?.input_modalities;
    if (source === "image") {
      // An image input is the evidence the model can start from a picture (image-to-image). How many it takes is not listed.
      const takesImage = inputs === undefined ? null : inputs.includes("image");
      const capabilities: CatalogCapabilities = {
        minSeconds: null,
        maxSeconds: null,
        aspectRatios: null,
        resolutions: null,
        firstFrame: takesImage,
        lastFrame: false,
        refsMax: takesImage === false ? 0 : null,
        audio: false,
      };
      const modelClasses: ModelClass[] = takesImage === true ? ["image.keyframe", "image.edit"] : ["image.keyframe"];
      keep(out, source, { id: model.id, modelClasses, capabilities, price, readAt });
      continue;
    }
    const capabilities: CatalogCapabilities = {
      minSeconds: null,
      maxSeconds: null,
      aspectRatios: null,
      resolutions: null,
      firstFrame: false,
      lastFrame: false,
      refsMax: 0,
      audio: true,
    };
    keep(out, source, { id: model.id, modelClasses: ["tts"], capabilities, price, readAt });
  }
  return out;
}

// ---- reading ------------------------------------------------------------------------------------------------------------

type SourceResult = { kind: "body"; body: unknown } | { kind: "failed"; reason: string } | { kind: "not_connected"; reason: string };

async function readSource(gateway: Gateway, organizationId: string | null, source: CatalogSource): Promise<SourceResult> {
  let result;
  try {
    result = await gateway.call({ provider: PROVIDER, organizationId, method: "GET", path: SOURCE_PATHS[source] });
  } catch (error) {
    return { kind: "failed", reason: `GET ${SOURCE_PATHS[source]} could not be sent: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}` };
  }
  if (result.status === "not_connected") return { kind: "not_connected", reason: result.reason };
  if (result.response.status !== 200) {
    const error = httpError(PROVIDER, result.response);
    if (error.kind === "config") return { kind: "not_connected", reason: error.message };
    return { kind: "failed", reason: `GET ${SOURCE_PATHS[source]} failed: ${error.message}` };
  }
  try {
    return { kind: "body", body: jsonBody(PROVIDER, result.response) };
  } catch (error) {
    return { kind: "failed", reason: `GET ${SOURCE_PATHS[source]} failed: ${error instanceof EngineError ? error.message : "the body is not JSON"}` };
  }
}

/**
 * Reads the three listings once, for one workspace's credential, and returns the catalog with its read time. Not connected (no key,
 * or a refused key) sends nothing more and returns not_connected. A listing that fails is named in `failed`; the others are kept.
 */
export async function readModelCatalog(gateway: Gateway, options: { organizationId: string | null; now?: () => number }): Promise<CatalogRead> {
  const now = options.now ?? (() => Date.now());
  const readAt = new Date(now()).toISOString();
  const catalog: ModelCatalog = { readAt, entries: [], dropped: [], failed: [], videoListing: null };
  for (const source of CATALOG_SOURCES) {
    const result = await readSource(gateway, options.organizationId, source);
    if (result.kind === "not_connected") return { status: "not_connected", reason: `NOT_CONNECTED: OpenRouter's catalog cannot be read: ${result.reason}` };
    if (result.kind === "failed") {
      catalog.failed.push({ source, reason: result.reason });
      continue;
    }
    const parsed = source === "videos" ? parseVideoCatalog(result.body, readAt) : parseModelsCatalog(source, result.body, readAt);
    if (parsed.entries.length === 0 && parsed.dropped.some((drop) => drop.id === null)) {
      // A listing with no data array is a failed listing, not an empty one.
      catalog.failed.push({ source, reason: `GET ${SOURCE_PATHS[source]} answered with no data array` });
      continue;
    }
    if (source === "videos") catalog.videoListing = result.body;
    catalog.entries.push(...parsed.entries);
    catalog.dropped.push(...parsed.dropped);
  }
  return { status: "read", catalog };
}

/**
 * The catalog, cached in memory per workspace for `ttlMs` (adapters.catalog.ttlMs by default). Only a read with no failed listing
 * is kept. Concurrent reads for one workspace share one request set.
 */
export function modelCatalogCache(options: { gateway: Gateway; ttlMs?: number; now?: () => number }): ModelCatalogSource {
  const ttlMs = options.ttlMs ?? adapters.catalog.ttlMs.value;
  const now = options.now ?? (() => Date.now());
  const kept = new Map<string, { atMs: number; read: CatalogRead }>();
  const inFlight = new Map<string, Promise<CatalogRead>>();
  return {
    async read(organizationId) {
      const cached = kept.get(organizationId);
      if (cached !== undefined && now() - cached.atMs < ttlMs) return cached.read;
      const pending = inFlight.get(organizationId);
      if (pending !== undefined) return pending;
      const startedMs = now();
      const reading = readModelCatalog(options.gateway, { organizationId, now }).finally(() => inFlight.delete(organizationId));
      inFlight.set(organizationId, reading);
      const read = await reading;
      if (read.status === "read" && read.catalog.failed.length === 0) kept.set(organizationId, { atMs: startedMs, read });
      else kept.delete(organizationId);
      return read;
    },
  };
}
