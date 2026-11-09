// Speech for the chat connector: OpenRouter's text-to-speech models, read from GET /models?output_modalities=speech and called with
// POST /audio/speech (OpenRouter's TTS guide: an OpenAI-compatible endpoint; the answer is the raw audio, and its X-Generation-Id header
// names the call for GET /generation?id=, which gives its bill). TTS is priced per character of input text. The connector holds a fixed
// ceiling for each voiceover and settles at the bill, so a per-character rate is shown to the person, never reserved.
//
// The listing is untrusted data: each row is checked, and a row that does not fit is left out. Pure: no network, no database.

import { z } from "zod";

export const SPEECH_LISTING_PATH = "/models?output_modalities=speech";
export const SPEECH_PATH = "/audio/speech";
/** The voices a model lists, as many as the connector shows and checks against. */
export const MAX_VOICES = 200;

/** A text-to-speech model: its id, its list rate per character of input (null when not stated) and the voices it lists (null: none listed). */
export type SpeechModel = { id: string; name: string | null; usdPerCharacter: number | null; voices: string[] | null };

const rowSchema = z.object({
  id: z.string().min(3).max(200),
  name: z.string().max(200).nullish(),
  pricing: z.record(z.string(), z.unknown()).nullish(),
  supported_voices: z.array(z.unknown()).nullish(),
  architecture: z.object({ output_modalities: z.array(z.string()).nullish() }).nullish(),
});

function rate(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** The speech models of one listing, cheapest first (unknown rates last). A row that is not a speech model, or does not parse, is left out. */
export function parseSpeechListing(body: unknown): SpeechModel[] {
  const data = body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : [];
  const models: SpeechModel[] = [];
  for (const raw of data) {
    const row = rowSchema.safeParse(raw);
    if (!row.success) continue;
    const outputs = row.data.architecture?.output_modalities;
    if (outputs && !outputs.includes("speech")) continue;
    const voices = row.data.supported_voices
      ? row.data.supported_voices.filter((voice): voice is string => typeof voice === "string" && voice.length > 0 && voice.length <= 120).slice(0, MAX_VOICES)
      : null;
    models.push({ id: row.data.id, name: row.data.name ?? null, usdPerCharacter: rate(row.data.pricing?.prompt), voices: voices && voices.length > 0 ? voices : null });
  }
  return models.sort((a, b) => (a.usdPerCharacter ?? Number.POSITIVE_INFINITY) - (b.usdPerCharacter ?? Number.POSITIVE_INFINITY) || a.id.localeCompare(b.id));
}

/** Why this voice cannot be asked of this model, or null. A model that lists its voices takes only those; one that lists none is asked as given. */
export function voiceProblem(model: SpeechModel, voice: string): string | null {
  if (model.voices === null) return null;
  if (model.voices.includes(voice)) return null;
  return `${model.id} has no voice '${voice}'. Its voices include: ${model.voices.slice(0, 12).join(", ")}.`;
}

/** The request body for one voiceover: MP3, the person's pace only when it is not 1, and a delivery style only when one is given. */
export function speechRequestBody(input: { model: string; text: string; voice: string; speed: number; instructions?: string | null }): string {
  return JSON.stringify({
    model: input.model,
    input: input.text,
    voice: input.voice,
    response_format: "mp3",
    ...(input.speed === 1 ? {} : { speed: input.speed }),
    ...(input.instructions ? { instructions: input.instructions } : {}),
  });
}

/** One line for a model in the list the chat shows: its rate per 1,000 characters and a few of its voices. */
export function speechModelLine(model: SpeechModel): string {
  const price = model.usdPerCharacter === null ? "price not stated" : model.usdPerCharacter === 0 ? "free" : `$${(model.usdPerCharacter * 1000).toFixed(4)} per 1,000 characters`;
  const voices = model.voices === null ? "voices: not listed" : `voices: ${model.voices.slice(0, 8).join(", ")}${model.voices.length > 8 ? `, and ${model.voices.length - 8} more` : ""}`;
  return `${model.id}: ${price}; ${voices}`;
}
