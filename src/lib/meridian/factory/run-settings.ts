/**
 * The one settings model (NORTH_STAR §4). A brand has defaults, and each Factory run or Studio plan can override them. The three
 * older vocabularies map onto it here, so no screen keeps its own meaning for "automatic".
 */
import { isCountryCode } from "./country-codes.ts";
import { budgets } from "../../../engine/config/budgets.ts";
import { sumUsd } from "../../../engine/contracts/money.ts";

export const AUTOMATION_MODES = ["manual", "semi", "full"] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export const INTENTS = ["organic", "ad", "both"] as const;
export type Intent = (typeof INTENTS)[number];

export const FORMATS = ["image", "video", "carousel"] as const;
export type Format = (typeof FORMATS)[number];

export const DECISION_ENGINE_CHOICES = ["workspace_default", "jev", "openai-decisions", "openrouter-decisions"] as const;
export type DecisionEngineChoice = (typeof DECISION_ENGINE_CHOICES)[number];

/**
 * The id of the Meridian video engine. A run that names it makes its videos through the engine's API (produce-engine.ts). A run whose engine
 * cannot run stops with the engine's own reason, and nothing is sent.
 */
export const ENGINE_VIDEO_PROVIDER_ID = "engine";

/**
 * The video providers a Factory run can name, in the order the run builder lists them. "auto" lets the capability matrix choose. The
 * produce stage routes each of the other ids through a provider call, and the engine id through the video engine (produce-engine.ts).
 */
export const FACTORY_VIDEO_PROVIDERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "auto", label: "Auto (the capability matrix chooses)" },
  { id: ENGINE_VIDEO_PROVIDER_ID, label: "Meridian video engine" },
  { id: "google_omni", label: "Google Gemini Omni" },
  { id: "hypit", label: "Hypit" },
  { id: "higgsfield", label: "Higgsfield" },
  { id: "manual_cloud", label: "Manual Cloud (Google Drive)" },
];

export type RunSettings = {
  /** manual: a person approves every step that spends or publishes. semi: a person approves once before spend and once before publish. full: runs inside caps. */
  automation: AutomationMode;
  decisionEngine: DecisionEngineChoice;
  intent: Intent;
  formats: Format[];
  /** Platform ids, such as facebook, instagram, youtube, tiktok. A platform with no connection is reported as not connected. */
  platforms: string[];
  /** Per format: "auto" lets the capability matrix choose, or a provider id. A named provider that is not ready stops the run. */
  providers: Partial<Record<Format, string>>;
  caps: { dailyCents: number; totalCents: number; maxVariants: number };
  /**
   * The countries a paid ad is targeted to: ISO 3166-1 alpha-2 codes in capitals (country-codes.ts). Empty means none is set. A live
   * paid publish needs at least one, and is refused with "no targeting country" without it.
   */
  targetingCountries: string[];
  /**
   * The budget the user sets for every master, in USD, or null when it is not set. A value is at most 2 decimals. A run that makes video
   * needs one at or above MASTER_COST_FLOOR_USD (runCostProblem); a stored value below it still parses. The engine checks the exact minimum of each video at
   * intake. Owner decision, 2026-10-14.
   */
  costPerMasterUsd: number | null;
  /**
   * The theme page this run targets (pages/model.ts), or null for none. The page's kits fill the engine request, and its trial default
   * applies to the run's Instagram posts. The page is checked against the brand when the run starts.
   */
  pageId: string | null;
  /**
   * The Facebook Page a live paid ad is created for, or null when none is set. A live paid publish needs this and a destination link.
   */
  facebookPageId: string | null;
  /** The https link a live paid ad sends people to, or null when none is set. */
  destinationLink: string | null;
};

export const DEFAULT_RUN_SETTINGS: RunSettings = {
  automation: "manual",
  decisionEngine: "workspace_default",
  intent: "organic",
  formats: ["video"],
  platforms: [],
  providers: {},
  caps: { dailyCents: 0, totalCents: 0, maxVariants: 8 },
  targetingCountries: [],
  costPerMasterUsd: null,
  pageId: null,
  facebookPageId: null,
  destinationLink: null,
};

/**
 * The floor every master costs: the fixed Claude, critic, render and media cost (Bible 14.2). It is summed from the engine's own budget
 * lines, not copied. The exact minimum of one video needs its script beats, which the run screen does not have, so the run screen
 * checks this floor and the engine checks the rest at intake.
 */
export const MASTER_COST_FLOOR_USD: number = sumUsd(Object.values(budgets.fixedPerMasterUsd));

/** A USD amount as text with at least 2 decimals, such as 0.52 or 0.525, for the words a person reads. */
function usdText(usd: number): string {
  const fourPlaces = usd.toFixed(4).replace(/0+$/, "");
  const decimals = fourPlaces.split(".")[1] ?? "";
  return decimals.length >= 2 ? fourPlaces : usd.toFixed(2);
}

/** The floor in words: the number the run screen shows, such as 0.52. */
export const MASTER_COST_FLOOR_TEXT: string = usdText(MASTER_COST_FLOOR_USD);

/** The sentence that names the floor, in the words the run screen uses. */
export const MASTER_COST_FLOOR_SENTENCE = `Every master costs at least $${MASTER_COST_FLOOR_TEXT}: the fixed Claude, critic, render and media cost.`;

/**
 * Why a stored cost per master is not a dollar amount, or null when it is one (or unset). This is the shape check only, used when
 * settings are parsed: a stored value is never refused for being below the floor, so raising the floor later cannot make saved
 * settings unreadable (and lose their caps). The floor is checked where a cost is set or a run starts (costPerMasterProblem).
 */
export function costPerMasterShapeProblem(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "The cost per master must be a dollar amount, such as 0.75.";
  if (Math.round(value * 100) / 100 !== value) return "The cost per master can have at most 2 decimals, such as 0.75.";
  return null;
}

/**
 * Why a cost per master cannot be set, in plain words. Null means it can. Unset (null) is allowed here, because a brand's defaults may
 * leave it blank. A run that makes video is refused without one by runCostProblem. Compared in ten-thousandths of a dollar, so a
 * typed amount and the floor compare exactly.
 */
export function costPerMasterProblem(value: unknown): string | null {
  const shape = costPerMasterShapeProblem(value);
  if (shape !== null || value === null) return shape;
  if (Math.round((value as number) * 10000) < Math.round(MASTER_COST_FLOOR_USD * 10000)) {
    return `The cost per master is below the floor. ${MASTER_COST_FLOOR_SENTENCE}`;
  }
  return null;
}

/**
 * Why a run cannot start for its formats, in plain words, or null when it can. A run that makes video needs a cost per master at or
 * above the floor. A run with no video (an image-only run) needs none.
 */
export function runCostProblem(settings: { formats: readonly Format[]; costPerMasterUsd: number | null }): string | null {
  if (!settings.formats.includes("video")) return null;
  if (settings.costPerMasterUsd === null) return `Type the cost per master (USD). ${MASTER_COST_FLOOR_SENTENCE}`;
  return costPerMasterProblem(settings.costPerMasterUsd);
}

const MAX_PLATFORMS = 8;
const MAX_CENTS = 100_000_000;
const MAX_VARIANTS = 40;
const MAX_TARGETING_COUNTRIES = 25;
const PLATFORM_ID = /^[a-z][a-z_]{1,19}$/;
const PAGE_REFERENCE = /^[A-Za-z0-9_-]{1,64}$/;
const FACEBOOK_PAGE_ID = /^[0-9]{1,32}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_:.-]{1,59}$/;

/**
 * Checks a list of targeting countries. Each entry must be a two-letter ISO 3166-1 code in capitals that is officially assigned. An
 * empty entry, a lowercase code and an unknown code are each refused with the reason. Duplicates are collapsed, in the order given.
 */
export function parseTargetingCountries(input: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "Targeting countries must be a list of two-letter country codes, such as US." };
  if (input.length > MAX_TARGETING_COUNTRIES) {
    return { ok: false, error: `Choose at most ${MAX_TARGETING_COUNTRIES} targeting countries.` };
  }
  const value: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string" || entry.trim() === "") {
      return { ok: false, error: "A targeting country is empty. Remove it, or give its two-letter code, such as US." };
    }
    if (!isCountryCode(entry)) {
      const hint = entry.length === 2 && /^[a-zA-Z]{2}$/.test(entry) && isCountryCode(entry.toUpperCase())
        ? ` Write it in capitals: ${entry.toUpperCase()}.`
        : "";
      return { ok: false, error: `${entry} is not an ISO 3166-1 country code.${hint} Use codes such as US, GB or DE.` };
    }
    if (!value.includes(entry)) value.push(entry);
  }
  return { ok: true, value };
}

export type SettingsResult = { ok: true; value: RunSettings } | { ok: false; error: string };

function optionalText(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "The Facebook Page id must be the numeric id of the Page, or empty." };
  const trimmed = value.trim();
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

/** An https link, or null when the field is empty. Anything else is refused. */
export function destinationLinkOf(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "The destination link must be an https link, or empty." };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > 2000) return { ok: false, error: "The destination link is too long." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "The destination link must be an https link." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "The destination link must be an https link." };
  return { ok: true, value: url.toString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates a settings object on the server. Only the keys present are checked, and they are laid over the base, so a partial
 * brand default or a partial run override is accepted. An unknown value is refused with the reason, never coerced.
 */
export function parseRunSettings(input: unknown, base: RunSettings = DEFAULT_RUN_SETTINGS): SettingsResult {
  if (!isRecord(input)) return { ok: false, error: "Run settings must be an object." };
  const next: RunSettings = { ...base, caps: { ...base.caps }, providers: { ...base.providers } };

  if (input.automation !== undefined) {
    if (!(AUTOMATION_MODES as readonly unknown[]).includes(input.automation)) {
      return { ok: false, error: `Automation must be one of ${AUTOMATION_MODES.join(", ")}.` };
    }
    next.automation = input.automation as AutomationMode;
  }
  if (input.decisionEngine !== undefined) {
    if (!(DECISION_ENGINE_CHOICES as readonly unknown[]).includes(input.decisionEngine)) {
      return { ok: false, error: `Decision engine must be one of ${DECISION_ENGINE_CHOICES.join(", ")}.` };
    }
    next.decisionEngine = input.decisionEngine as DecisionEngineChoice;
  }
  if (input.intent !== undefined) {
    if (!(INTENTS as readonly unknown[]).includes(input.intent)) {
      return { ok: false, error: `Intent must be one of ${INTENTS.join(", ")}.` };
    }
    next.intent = input.intent as Intent;
  }
  if (input.formats !== undefined) {
    if (!Array.isArray(input.formats) || input.formats.length === 0) {
      return { ok: false, error: "Choose at least one format: image, video or carousel." };
    }
    const formats = [...new Set(input.formats)];
    if (formats.some((format) => !(FORMATS as readonly unknown[]).includes(format))) {
      return { ok: false, error: `Formats must be ${FORMATS.join(", ")}.` };
    }
    next.formats = formats as Format[];
  }
  if (input.platforms !== undefined) {
    if (!Array.isArray(input.platforms) || input.platforms.length > MAX_PLATFORMS) {
      return { ok: false, error: `Choose at most ${MAX_PLATFORMS} platforms.` };
    }
    const platforms = [...new Set(input.platforms)];
    if (platforms.some((item) => typeof item !== "string" || !PLATFORM_ID.test(item))) {
      return { ok: false, error: "A platform id is lowercase letters and underscores, such as instagram or tiktok." };
    }
    next.platforms = platforms as string[];
  }
  if (input.providers !== undefined) {
    if (!isRecord(input.providers)) return { ok: false, error: "Providers must map each format to a provider id or auto." };
    const providers: Partial<Record<Format, string>> = {};
    for (const [format, value] of Object.entries(input.providers)) {
      if (!(FORMATS as readonly string[]).includes(format)) return { ok: false, error: `Providers can only be set for ${FORMATS.join(", ")}.` };
      if (value !== "auto" && (typeof value !== "string" || !PROVIDER_ID.test(value))) {
        return { ok: false, error: `The ${format} provider must be auto or a provider id.` };
      }
      providers[format as Format] = value as string;
    }
    next.providers = providers;
  }
  if (input.caps !== undefined) {
    if (!isRecord(input.caps)) return { ok: false, error: "Caps must be an object." };
    const caps = { ...next.caps };
    for (const [key, label] of [["dailyCents", "The daily cap"], ["totalCents", "The total cap"]] as const) {
      const value = input.caps[key];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_CENTS) {
        return { ok: false, error: `${label} must be a whole number of cents from 0 to ${MAX_CENTS}.` };
      }
      caps[key] = value as number;
    }
    if (input.caps.maxVariants !== undefined) {
      const variants = input.caps.maxVariants;
      if (!Number.isInteger(variants) || (variants as number) < 1 || (variants as number) > MAX_VARIANTS) {
        return { ok: false, error: `Max variants per run must be a whole number from 1 to ${MAX_VARIANTS}.` };
      }
      caps.maxVariants = variants as number;
    }
    next.caps = caps;
  }
  if (input.targetingCountries !== undefined) {
    const countries = parseTargetingCountries(input.targetingCountries);
    if (!countries.ok) return countries;
    next.targetingCountries = countries.value;
  }
  if (input.costPerMasterUsd !== undefined) {
    // null means the user has not set a cost. A key that is absent keeps the base value, which is null for a stored setting that predates it.
    // Shape only: the floor is checked when a run starts (runCostProblem), so stored settings stay readable if the floor rises.
    const problem = costPerMasterShapeProblem(input.costPerMasterUsd);
    if (problem) return { ok: false, error: problem };
    next.costPerMasterUsd = input.costPerMasterUsd as number | null;
  }
  if (input.pageId !== undefined) {
    // null means no page. A page id is checked against the brand when the run starts, because this function reads no database.
    if (input.pageId !== null && (typeof input.pageId !== "string" || !PAGE_REFERENCE.test(input.pageId))) {
      return { ok: false, error: "The page must be one of this brand's pages, or none." };
    }
    next.pageId = input.pageId as string | null;
  }
  if (input.facebookPageId !== undefined) {
    const page = optionalText(input.facebookPageId);
    if (!page.ok) return page;
    if (page.value !== null && !FACEBOOK_PAGE_ID.test(page.value)) {
      return { ok: false, error: "The Facebook Page id is the numeric id of the Page." };
    }
    next.facebookPageId = page.value;
  }
  if (input.destinationLink !== undefined) {
    const link = destinationLinkOf(input.destinationLink);
    if (!link.ok) return link;
    next.destinationLink = link.value;
  }
  return { ok: true, value: next };
}

/** The effective settings for a run: the built-in defaults, then the brand's defaults, then the run's own overrides. */
export function mergeRunSettings(brandDefaults: Partial<RunSettings> | null, overrides: Partial<RunSettings> | null): RunSettings {
  return {
    ...DEFAULT_RUN_SETTINGS,
    ...(brandDefaults ?? {}),
    ...(overrides ?? {}),
    caps: { ...DEFAULT_RUN_SETTINGS.caps, ...(brandDefaults?.caps ?? {}), ...(overrides?.caps ?? {}) },
    providers: { ...(brandDefaults?.providers ?? {}), ...(overrides?.providers ?? {}) },
  };
}

/**
 * The old Factory levels, read as automation modes. Level 0 and 1 stop before any spend (manual). Level 2 stopped before a
 * launch, which is a single approval (semi). Level 3 ran end to end (full). NORTH_STAR §4.
 */
export function automationFromFactoryLevel(level: number): AutomationMode {
  if (level >= 3) return "full";
  if (level === 2) return "semi";
  return "manual";
}

/** Studio plans: manual, semi_automatic and fully_automatic map one to one. */
export function automationFromStudioAutonomy(autonomy: "manual" | "semi_automatic" | "fully_automatic"): AutomationMode {
  if (autonomy === "fully_automatic") return "full";
  if (autonomy === "semi_automatic") return "semi";
  return "manual";
}

/**
 * The brain's automation level. assisted means the system suggests and a person does each step, so manual. automated means
 * the system does the steps and stops for a person, so semi. autonomous runs inside caps, so full. This mapping is a
 * decision made in code; the owner can change it.
 */
export function automationFromBrainLevel(level: "manual" | "assisted" | "automated" | "autonomous"): AutomationMode {
  if (level === "autonomous") return "full";
  if (level === "automated") return "semi";
  return "manual";
}

/** The Studio word for an automation mode. The reverse of automationFromStudioAutonomy. */
export function studioAutonomyOfAutomation(mode: AutomationMode): "manual" | "semi_automatic" | "fully_automatic" {
  if (mode === "full") return "fully_automatic";
  if (mode === "semi") return "semi_automatic";
  return "manual";
}

/**
 * Where a brand's Factory runs and Studio plans start: the brand's saved run defaults when it has them, otherwise the brain's
 * automation level. Every surface reads this one answer, so a brand's default is set in one place.
 */
export function brandAutomationDefault(input: {
  runDefaults: string | null | undefined;
  brainLevel: "manual" | "assisted" | "automated" | "autonomous";
}): AutomationMode {
  const saved = parseStoredSettings(input.runDefaults);
  return saved ? saved.automation : automationFromBrainLevel(input.brainLevel);
}

/** The Factory level the existing owner ceiling and autopilot checks hold a mode to: manual is 1, semi 2 and full 3. */
export function factoryLevelOfAutomation(mode: AutomationMode): 1 | 2 | 3 {
  if (mode === "full") return 3;
  if (mode === "semi") return 2;
  return 1;
}

/** A settings object as stored, checked again on the way out. Null when nothing valid is stored. */
export function parseStoredSettings(stored: string | null | undefined): RunSettings | null {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!isRecord(parsed) || Object.keys(parsed).length === 0) return null;
    const checked = parseRunSettings(parsed);
    return checked.ok ? checked.value : null;
  } catch {
    return null;
  }
}

/** The settings a run was started with. A run stored before settings existed is read from its level. */
export function runSettingsFromStorage(stored: string | null | undefined, legacyLevel: number): RunSettings {
  return parseStoredSettings(stored) ?? mergeRunSettings(null, { automation: automationFromFactoryLevel(legacyLevel) });
}
