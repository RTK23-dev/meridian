/**
 * Gemini decision models, read live from Google's own model list. Nothing here names a model: a model is offered only because Google's
 * list says it can generate content, and "latest" is worked out from the versions in that list, so a newer Gemini appears when Google
 * lists it. The list is read with the workspace's own Gemini key. A failed read offers nothing and says why.
 */
export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export type GeminiModel = {
  /** The id without the "models/" prefix, as generateContent takes it. */
  id: string;
  name: string;
  description: string;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
  /** The model's version as numbers (2.5 is [2, 5]), or null when its name carries none. Used only to order the list. */
  version: number[] | null;
  /** True for the one model offered as the latest. */
  latest: boolean;
};

export type GeminiModelRead = { ok: true; models: GeminiModel[]; readAt: string } | { ok: false; reason: string; readAt: string };

/** Names that are not general text models: embeddings, speech, image generation, live audio, and the like. */
const NOT_A_TEXT_MODEL = /(embedding|tts|image|imagen|veo|live|audio|aqa|robotics|computer-use|learnlm|gemma)/i;

/** The numbers in a model name after "gemini-", for example gemini-2.5-flash gives [2, 5]. */
export function geminiVersion(id: string): number[] | null {
  const match = /^gemini-(\d+(?:\.\d+)*)/i.exec(id);
  if (!match) return null;
  return match[1].split(".").map(Number);
}

function compareVersions(a: number[] | null, b: number[] | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Within one version, a larger tier first: pro, then flash, then flash-lite and the rest. Previews and experiments come after releases. */
function tierRank(id: string): number {
  const lower = id.toLowerCase();
  const tier = lower.includes("pro") ? 0 : lower.includes("lite") ? 2 : lower.includes("flash") ? 1 : 3;
  const unreleased = /(preview|exp)/.test(lower) ? 10 : 0;
  return tier + unreleased;
}

/** Keeps the models Google says can generate content, drops the ones that are not text models, and orders newest first. */
export function parseGeminiModels(body: unknown, readAt: string): GeminiModelRead {
  const list = body && typeof body === "object" ? (body as { models?: unknown }).models : undefined;
  if (!Array.isArray(list)) return { ok: false, reason: "Google's model list did not have the expected shape, so no model could be offered.", readAt };
  const models: GeminiModel[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name : "";
    const id = name.replace(/^models\//, "");
    if (!/^gemini-/i.test(id) || NOT_A_TEXT_MODEL.test(id)) continue;
    const methods = Array.isArray(entry.supportedGenerationMethods) ? entry.supportedGenerationMethods : [];
    if (!methods.includes("generateContent")) continue;
    const limit = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
    models.push({
      id,
      name: typeof entry.displayName === "string" && entry.displayName ? entry.displayName : id,
      description: typeof entry.description === "string" ? entry.description.slice(0, 300) : "",
      inputTokenLimit: limit(entry.inputTokenLimit),
      outputTokenLimit: limit(entry.outputTokenLimit),
      version: geminiVersion(id),
      latest: false,
    });
  }
  models.sort((a, b) => compareVersions(a.version, b.version) || tierRank(a.id) - tierRank(b.id) || a.id.localeCompare(b.id));
  // "Latest" is the newest released model: previews are not offered as the latest while a released one exists.
  const latest = models.find((model) => tierRank(model.id) < 10) ?? models[0];
  if (latest) latest.latest = true;
  return { ok: true, models, readAt };
}

/** Reads Google's model list with the given key. The key travels in a header, never in the address. */
export async function readGeminiModels(apiKey: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<GeminiModelRead> {
  const readAt = new Date(now()).toISOString();
  if (!apiKey) return { ok: false, reason: "No Gemini key is saved for this workspace, so Google's model list could not be read.", readAt };
  try {
    const response = await fetchImpl(`${GEMINI_API_BASE}/models?pageSize=200`, {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return { ok: false, reason: `Google's model list answered HTTP ${response.status}. ${response.status === 400 || response.status === 403 ? "The Gemini key may be wrong or not allowed." : ""}`.trim(), readAt };
    }
    return parseGeminiModels(await response.json(), readAt);
  } catch {
    return { ok: false, reason: "Google's model list could not be reached.", readAt };
  }
}
