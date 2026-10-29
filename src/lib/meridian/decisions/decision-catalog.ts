/**
 * The live OpenRouter catalogue of decision models, read and checked before any model is offered or called.
 *
 * Eligibility for the Decisions endpoint is the catalogue's own filter: an entry whose `architecture.output_modalities` contains
 * `decisions`. The catalogue does not say which question primitives a model answers, so Meridian records a profile for each model
 * it has verified against the documentation. A model with no profile is listed with its reason and is not offered. Aliases (IDs
 * that start with `~`) are never offered, because they move to new builds. A model whose catalogue entry gives no usable input price
 * or no context length is not offered either, because a call's cost could not be bounded before it is sent.
 *
 * The catalogue is public and is read without a key. Nothing from a workspace is sent with the request.
 */
import { z } from "zod";
import type { DecisionQuestionKind } from "./types.ts";
import { openRouterDecisionMaxUsdPerCallSetting } from "../config/server-settings.ts";

export const OPENROUTER_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
export const DECISION_CATALOG_TIMEOUT_MS = 15_000;
export const DECISION_CATALOG_CACHE_MS = 10 * 60_000;
/** A failed read is remembered briefly, so a blocked network does not delay every decision by the full timeout. */
export const DECISION_CATALOG_FAILURE_CACHE_MS = 60_000;

/** What a verified decision model is documented to take. Each profile names the source it was checked against. */
export type DecisionModelProfile = {
  questionKinds: DecisionQuestionKind[];
  inputModalities: Array<"text" | "image">;
  /** Where the profile comes from. A profile is a claim about the vendor's documentation, not a probe of a live call. */
  source: string;
};

const TYPESAFE_PROFILE_SOURCE = "TypeSafe's published decision documentation, as recorded in docs/OPENROUTER.md. No live call has been recorded.";

/**
 * The decision models Meridian has verified. A model is offered only with a profile here, and the profile is the source of what it
 * may be asked. Nothing here is inferred from a model's name.
 *
 * `typesafe/jev-1.13` is listed text-only. The live catalogue now lists it with image input too, but the documentation recorded
 * here states text only, so the stricter reading is kept until a verified source or a live check says otherwise.
 */
export const DECISION_MODEL_PROFILES: Record<string, DecisionModelProfile> = {
  "typesafe/jev-1.14": {
    questionKinds: ["predicate", "choice", "score"],
    inputModalities: ["text", "image"],
    source: TYPESAFE_PROFILE_SOURCE,
  },
  "typesafe/jev-1.13": {
    questionKinds: ["predicate", "choice", "score"],
    inputModalities: ["text"],
    source: TYPESAFE_PROFILE_SOURCE,
  },
};

/** The profile for a pinned model ID, or null when Meridian has not verified it. Aliases never have one. */
export function decisionModelProfile(model: string): DecisionModelProfile | null {
  if (model.startsWith("~")) return null;
  return Object.prototype.hasOwnProperty.call(DECISION_MODEL_PROFILES, model) ? DECISION_MODEL_PROFILES[model] : null;
}

const catalogEntrySchema = z.object({
  id: z.string().min(1).max(128),
  canonical_slug: z.string().min(1).max(160).optional(),
  name: z.string().max(200).optional(),
  architecture: z.object({
    input_modalities: z.array(z.string()).default([]),
    output_modalities: z.array(z.string()).default([]),
  }),
  context_length: z.number().int().positive().nullable().optional(),
  pricing: z.object({ prompt: z.string().optional(), completion: z.string().optional() }).optional(),
  top_provider: z.object({ max_completion_tokens: z.number().int().nonnegative().nullable().optional() }).optional(),
  alias_target: z.unknown().optional(),
});

const catalogBodySchema = z.object({ data: z.array(z.unknown()) });

export type DecisionCatalogEntry = {
  id: string;
  canonicalSlug: string | null;
  name: string;
  inputModalities: string[];
  /** Tokens. The input cannot exceed this, so it bounds a call's input cost. */
  contextLength: number;
  /** USD per input token, as the catalogue states it. */
  promptUsdPerToken: number;
  /** USD per output token, as the catalogue states it. Zero when the catalogue prices output at zero. */
  completionUsdPerToken: number;
  /** Tokens. The largest output the model can return, which bounds a call's output cost. */
  maxCompletionTokens: number;
};

export type DecisionCatalogExclusion = { id: string; reason: string };

export type DecisionCatalogRead =
  | { ok: true; entries: DecisionCatalogEntry[]; excluded: DecisionCatalogExclusion[]; endpoint: string; readAt: string }
  | { ok: false; reason: string; endpoint: string; readAt: string };

/** A price string, read as USD per token. An absent, non-numeric or negative price is unknown (null), never zero. */
export function parseUsdPerToken(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Reads a decisions-filtered catalogue body. A malformed body fails the whole read. A malformed or ineligible entry is excluded with
 * its reason, and the rest of the catalogue is still usable.
 */
export function parseDecisionCatalog(body: unknown, meta: { endpoint: string; readAt: string }): DecisionCatalogRead {
  const top = catalogBodySchema.safeParse(body);
  if (!top.success) {
    return { ok: false, reason: "The OpenRouter model catalogue did not have the expected shape, so no decision model could be checked.", ...meta };
  }
  const entries: DecisionCatalogEntry[] = [];
  const excluded: DecisionCatalogExclusion[] = [];
  for (const raw of top.data.data) {
    const id = typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : "(no id)";
    const parsed = catalogEntrySchema.safeParse(raw);
    if (!parsed.success) {
      excluded.push({ id, reason: "The catalogue entry is missing or malformed, so its capabilities cannot be read." });
      continue;
    }
    const entry = parsed.data;
    if (!entry.architecture.output_modalities.includes("decisions")) {
      excluded.push({ id, reason: "Not a decision model: its output is not 'decisions'." });
      continue;
    }
    if (entry.id.startsWith("~") || entry.alias_target !== undefined) {
      excluded.push({ id, reason: "An alias moves to new builds, so it is not offered. Its pinned target is listed separately." });
      continue;
    }
    const price = parseUsdPerToken(entry.pricing?.prompt);
    if (price === null) {
      excluded.push({ id, reason: "The catalogue gives no usable input price, so a call's cost cannot be bounded before it is sent." });
      continue;
    }
    if (!entry.context_length) {
      excluded.push({ id, reason: "The catalogue gives no context length, so the input size cannot be bounded." });
      continue;
    }
    const completion = parseUsdPerToken(entry.pricing?.completion);
    if (completion === null) {
      excluded.push({ id, reason: "The catalogue gives no usable output price, so a call's output cost cannot be bounded before it is sent." });
      continue;
    }
    const maxCompletionTokens = entry.top_provider?.max_completion_tokens ?? null;
    if (completion > 0 && maxCompletionTokens === null) {
      excluded.push({ id, reason: "The catalogue prices output but gives no largest output, so a call's output cost cannot be bounded." });
      continue;
    }
    entries.push({
      id: entry.id,
      canonicalSlug: entry.canonical_slug ?? null,
      name: entry.name ?? entry.id,
      inputModalities: entry.architecture.input_modalities,
      contextLength: entry.context_length,
      promptUsdPerToken: price,
      completionUsdPerToken: completion,
      maxCompletionTokens: maxCompletionTokens ?? 0,
    });
  }
  return { ok: true, entries, excluded, ...meta };
}

/** A decision model that is in the catalogue and has a verified profile. Only these are offered or called. */
export type EligibleDecisionModel = DecisionCatalogEntry & { profile: DecisionModelProfile };

/** Splits a read catalogue into the models Meridian offers and the ones it lists with the reason they are not offered. */
export function eligibleDecisionModels(read: Extract<DecisionCatalogRead, { ok: true }>): {
  eligible: EligibleDecisionModel[];
  notOffered: DecisionCatalogExclusion[];
} {
  const eligible: EligibleDecisionModel[] = [];
  const notOffered: DecisionCatalogExclusion[] = [...read.excluded];
  for (const entry of read.entries) {
    const profile = decisionModelProfile(entry.id);
    if (!profile) {
      notOffered.push({ id: entry.id, reason: "Meridian has not verified which questions this model answers, so it is not offered." });
      continue;
    }
    eligible.push({ ...entry, profile });
  }
  return { eligible, notOffered };
}

/**
 * The most one call can cost, in USD, computed before the call is sent from the request it would send.
 *
 * Input: a tokenizer produces at most one token per byte, so the request's UTF-8 byte count bounds its input tokens, and the
 * model's context bounds them too. A call with an image uses the whole context, because the tokens an image takes are not stated
 * in the catalogue. Output: the model's largest output, at its output price. The result is a reservation, not an estimate, and
 * it is never zero for a call that has input.
 */
export function decisionCallCeilingUsd(
  entry: Pick<DecisionCatalogEntry, "contextLength" | "promptUsdPerToken" | "completionUsdPerToken" | "maxCompletionTokens">,
  call: { requestBytes: number; hasImages: boolean },
): number {
  const inputTokens = call.hasImages ? entry.contextLength : Math.min(call.requestBytes, entry.contextLength);
  return inputTokens * entry.promptUsdPerToken + entry.maxCompletionTokens * entry.completionUsdPerToken;
}

/** The most any call to the model can cost: its whole context at the input price, plus its largest output. Shown beside the model. */
export function decisionModelCeilingUsd(
  entry: Pick<DecisionCatalogEntry, "contextLength" | "promptUsdPerToken" | "completionUsdPerToken" | "maxCompletionTokens">,
): number {
  return decisionCallCeilingUsd(entry, { requestBytes: entry.contextLength, hasImages: true });
}

/** The default per-call ceiling, in USD. The deployment sets its own with OPENROUTER_DECISION_MAX_USD_PER_CALL. */
export const DEFAULT_DECISION_MAX_USD_PER_CALL = 0.05;

/**
 * The per-call ceiling the deployment allows. An unset variable uses the default. A set variable that is not a positive number is
 * refused, so a mistyped limit can never allow more than it says.
 */
export function decisionCallCapUsd(): { ok: true; usd: number } | { ok: false; reason: string } {
  const raw = openRouterDecisionMaxUsdPerCallSetting();
  if (raw === undefined || raw.trim() === "") return { ok: true, usd: DEFAULT_DECISION_MAX_USD_PER_CALL };
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd <= 0) {
    return { ok: false, reason: "OPENROUTER_DECISION_MAX_USD_PER_CALL is not a positive number, so no decision was sent." };
  }
  return { ok: true, usd };
}

/**
 * Reads the live catalogue, with a short cache. A failed read is not cached, so the next decision asks again. The cache holds only
 * the catalogue: it is never evidence that a key works or that a connection passed.
 */
export class DecisionCatalogSource {
  private cached: { read: Extract<DecisionCatalogRead, { ok: true }>; expiresAt: number } | null = null;
  private failed: { read: Extract<DecisionCatalogRead, { ok: false }>; expiresAt: number } | null = null;

  private readonly options: { fetchImpl?: typeof fetch; now?: () => number; endpoint?: string };

  constructor(options: { fetchImpl?: typeof fetch; now?: () => number; endpoint?: string } = {}) {
    this.options = options;
  }

  async read(): Promise<DecisionCatalogRead> {
    const now = this.options.now ?? Date.now;
    const endpoint = `${this.options.endpoint ?? OPENROUTER_MODELS_ENDPOINT}?output_modalities=decisions`;
    if (this.cached && this.cached.expiresAt > now()) return this.cached.read;
    if (this.failed && this.failed.expiresAt > now()) return this.failed.read;
    const readAt = new Date(now()).toISOString();
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const fail = (reason: string): Extract<DecisionCatalogRead, { ok: false }> => {
      const read = { ok: false as const, reason, endpoint, readAt };
      this.failed = { read, expiresAt: now() + DECISION_CATALOG_FAILURE_CACHE_MS };
      return read;
    };
    try {
      const response = await fetchImpl(endpoint, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(DECISION_CATALOG_TIMEOUT_MS),
      });
      if (!response.ok) {
        return fail(`The OpenRouter model catalogue returned ${response.status}, so no decision model could be checked.`);
      }
      const result = parseDecisionCatalog(await response.json(), { endpoint, readAt });
      if (!result.ok) return fail(result.reason);
      this.failed = null;
      this.cached = { read: result, expiresAt: now() + DECISION_CATALOG_CACHE_MS };
      return result;
    } catch {
      return fail("The OpenRouter model catalogue could not be reached, so no decision model could be checked.");
    }
  }
}

/** The catalogue source the application uses by default. Tests pass their own. */
export const liveDecisionCatalog = new DecisionCatalogSource();
