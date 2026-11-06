/**
 * Model presets: one click sets every writing task's model, picked from the live OpenRouter catalogue as it is now. No model id is
 * written down here, so a preset never names a model the catalogue no longer lists. A family is matched by the catalogue id's vendor
 * ("anthropic/...", "deepseek/...").
 *
 * Within a family only the current generation counts: the models the listing dates within six months of the family's newest one. Price
 * alone would pick an older model that still costs more than its successor. Within that generation the flagship is the one with the
 * highest output price that suits the task, and the budget pick the one with the lowest. Only a model's own id is picked, never a
 * variant (":free", ":batch", ":thinking" and the like) or an alias ("~..."). A task a preset cannot fill is left on Auto, and the
 * result says why.
 */
import type { GenerationTask } from "./generation-models.ts";
import { boundGenerationCall } from "../providers/generation-ledger.ts";
import type { TextModelChoice } from "../../../engine/orchestrator/settings.ts";

/** The output an image call is bounded at when a preset checks it against the per-call ceiling (perception asks for at most 2,000 tokens). */
export const PRESET_IMAGE_MAX_TOKENS = 2_000;

/**
 * Whether one image call to this model fits the per-call ceiling. An image call is bounded at the model's whole context (the listing
 * states no image tokens) plus the output limit, the same bound the call itself is checked against, so a model that does not fit would
 * be refused on every image call.
 */
export function imageCallFitsCeiling(model: Pick<TextModelChoice, "promptUsdPerToken" | "completionUsdPerToken" | "contextLength">, ceilingUsd: number): boolean {
  const bound = boundGenerationCall({ choice: model, system: "", user: [{ type: "image_url", image_url: { url: "data:image/png;base64," } }], maxTokens: PRESET_IMAGE_MAX_TOKENS });
  return bound.ok && bound.usd <= ceilingUsd;
}

export type PresetCatalogueModel = {
  id: string;
  name: string;
  completionUsdPerMillionTokens: number;
  promptUsdPerMillionTokens: number;
  /** When the listing says the model was added, in seconds since 1970, or null when it does not say. */
  created: number | null;
  /**
   * The tasks this model suits. An image task (vision, reference analysis) needs a model that reads images and whose worst-case image call
   * fits the per-call ceiling; the server decides this, so a preset never picks a model every call of which would be refused.
   */
  suitsTasks: readonly GenerationTask[];
};

export const MODEL_PRESET_IDS = ["claude", "frontier", "budget"] as const;
export type ModelPresetId = (typeof MODEL_PRESET_IDS)[number];

export const MODEL_PRESETS: Record<ModelPresetId, { label: string; description: string }> = {
  claude: { label: "Claude only", description: "Every task on Anthropic's Claude: the flagship writes, a fast Claude analyses." },
  frontier: {
    label: "Frontier mix",
    description: "Claude writes, OpenAI or Google writes a second set of ideas and judges, and a cheap DeepSeek model does the bulk analysis.",
  },
  budget: { label: "Budget", description: "DeepSeek for every text task and a cheap current model that reads images for vision." },
};

export function isModelPreset(value: unknown): value is ModelPresetId {
  return typeof value === "string" && (MODEL_PRESET_IDS as readonly string[]).includes(value);
}

export type PresetChoice = { task: GenerationTask; modelId: string | null; reason: string };

/** How far back from a family's newest model the current generation reaches. */
export const CURRENT_GENERATION_SECONDS = 183 * 24 * 60 * 60;

/** The families a budget fallback looks in, in order, so a cheap pick is a known model and not the cheapest of four hundred. */
const MAIN_FAMILIES = ["deepseek", "google", "openai", "anthropic"] as const;

const vendorOf = (id: string) => id.split("/")[0] ?? "";

/** A model's own id: not a variant such as ":free" (rate-limited, comes and goes) or ":batch" (answers late), and not an alias. */
const isBaseModel = (id: string) => !id.includes(":") && !id.startsWith("~");

/** The models of one family that suit the task, from its current generation only. */
function currentOf(models: readonly PresetCatalogueModel[], task: GenerationTask, vendor: string): PresetCatalogueModel[] {
  const family = models.filter((model) => vendorOf(model.id) === vendor && isBaseModel(model.id) && model.suitsTasks.includes(task));
  const dated = family.filter((model) => model.created !== null);
  // A family the listing does not date is taken as it is: nothing is known about which of its models is older.
  if (dated.length === 0) return family;
  const newest = Math.max(...dated.map((model) => model.created!));
  return dated.filter((model) => model.created! >= newest - CURRENT_GENERATION_SECONDS);
}

/** Cheapest first; on a tie, the newer model first, then by id so the order is stable. */
const cheaperFirst = (a: PresetCatalogueModel, b: PresetCatalogueModel) =>
  a.completionUsdPerMillionTokens - b.completionUsdPerMillionTokens ||
  a.promptUsdPerMillionTokens - b.promptUsdPerMillionTokens ||
  (b.created ?? 0) - (a.created ?? 0) ||
  a.id.localeCompare(b.id);

/** Most expensive first; on a tie, the newer model first, then by id. */
const dearerFirst = (a: PresetCatalogueModel, b: PresetCatalogueModel) =>
  b.completionUsdPerMillionTokens - a.completionUsdPerMillionTokens ||
  b.promptUsdPerMillionTokens - a.promptUsdPerMillionTokens ||
  (b.created ?? 0) - (a.created ?? 0) ||
  a.id.localeCompare(b.id);

/** The flagship (highest output price, current generation) of the first family in `vendors` that has a model for the task. */
function flagship(models: readonly PresetCatalogueModel[], task: GenerationTask, vendors: readonly string[]): PresetCatalogueModel | null {
  for (const vendor of vendors) {
    const list = currentOf(models, task, vendor).sort(dearerFirst);
    if (list.length > 0) return list[0]!;
  }
  return null;
}

/** The cheapest current model of the first family in `vendors` that has one for the task. */
function cheapest(models: readonly PresetCatalogueModel[], task: GenerationTask, vendors: readonly string[]): PresetCatalogueModel | null {
  for (const vendor of vendors) {
    const list = currentOf(models, task, vendor).sort(cheaperFirst);
    if (list.length > 0) return list[0]!;
  }
  return null;
}

const pick = (task: GenerationTask, model: PresetCatalogueModel | null, why: string, missing: string): PresetChoice =>
  model ? { task, modelId: model.id, reason: `${model.name}: ${why}` } : { task, modelId: null, reason: `Auto: ${missing}` };

/** Every task's model for a preset, from the catalogue given. */
export function presetChoices(preset: ModelPresetId, models: readonly PresetCatalogueModel[]): PresetChoice[] {
  if (preset === "claude") {
    return [
      pick("copy", flagship(models, "copy", ["anthropic"]), "the Claude flagship writes.", "the catalogue lists no Claude model for writing."),
      pick("research_analysis", cheapest(models, "research_analysis", ["anthropic"]), "a fast Claude analyses.", "no Claude model suits analysis."),
      pick("brain_suggest", cheapest(models, "brain_suggest", ["anthropic"]), "a fast Claude suggests.", "no Claude model suits suggestions."),
      pick("vision", flagship(models, "vision", ["anthropic"]), "a Claude that reads images.", "no Claude model that reads images fits the per-call ceiling."),
      pick("reference_analysis", cheapest(models, "reference_analysis", ["anthropic"]), "a fast Claude reads references.", "no Claude model that reads images fits the per-call ceiling."),
      { task: "direction_writer", modelId: null, reason: "Auto: one family only, so the Claude writer writes every idea." },
      { task: "direction_judge", modelId: null, reason: "Auto: one family only, so the Claude writer also judges." },
    ];
  }
  if (preset === "frontier") {
    const writer = flagship(models, "direction_writer", ["openai", "google"]);
    const judgeVendors = ["google", "openai"].filter((vendor) => vendor !== (writer ? vendorOf(writer.id) : ""));
    return [
      pick("copy", flagship(models, "copy", ["anthropic", "openai", "google"]), "a frontier model writes.", "no frontier model is listed."),
      pick("direction_writer", writer, "a second family writes half the ideas.", "no OpenAI or Google model is listed."),
      pick("direction_judge", flagship(models, "direction_judge", judgeVendors), "a third family judges, so no writer judges its own ideas.", "no third family is listed."),
      pick("research_analysis", cheapest(models, "research_analysis", MAIN_FAMILIES), "cheap bulk analysis.", "no model suits analysis."),
      pick("brain_suggest", cheapest(models, "brain_suggest", MAIN_FAMILIES), "cheap suggestions.", "no model suits suggestions."),
      pick("vision", flagship(models, "vision", ["google", "openai", "anthropic"]), "a frontier model that reads images.", "no frontier model that reads images fits the per-call ceiling."),
      pick("reference_analysis", cheapest(models, "reference_analysis", ["google", "openai", "anthropic"]), "a fast frontier model reads references.", "no frontier model that reads images fits the per-call ceiling."),
    ];
  }
  const deepseekWriter = flagship(models, "copy", ["deepseek"]);
  const cheap = (model: PresetCatalogueModel | null, what: string) =>
    model && vendorOf(model.id) === "deepseek" ? `the cheapest current DeepSeek ${what}.` : `the cheapest current model ${what} (no DeepSeek model suits it).`;
  const analysis = cheapest(models, "research_analysis", MAIN_FAMILIES);
  const suggest = cheapest(models, "brain_suggest", MAIN_FAMILIES);
  return [
    deepseekWriter
      ? pick("copy", deepseekWriter, "DeepSeek's best current model writes.", "")
      : pick("copy", cheapest(models, "copy", MAIN_FAMILIES), "a cheap current model writes (no DeepSeek model is listed).", "no model suits writing."),
    pick("research_analysis", analysis, cheap(analysis, "analyses"), "no model suits analysis."),
    pick("brain_suggest", suggest, cheap(suggest, "suggests"), "no model suits suggestions."),
    pick("vision", cheapest(models, "vision", MAIN_FAMILIES), "a cheap current model that reads images.", "no model that reads images fits the per-call ceiling."),
    pick("reference_analysis", cheapest(models, "reference_analysis", MAIN_FAMILIES), "a cheap current model reads references.", "no model that reads images fits the per-call ceiling."),
    { task: "direction_writer", modelId: null, reason: "Auto: the writer writes every idea, which keeps the run cheap." },
    { task: "direction_judge", modelId: null, reason: "Auto: the writer also judges, which keeps the run cheap." },
  ];
}
