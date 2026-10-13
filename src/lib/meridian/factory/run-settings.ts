/**
 * The one settings model (NORTH_STAR §4). A brand has defaults, and each Factory run or Studio plan can override them. The three
 * older vocabularies map onto it here, so no screen keeps its own meaning for "automatic".
 */
import { isCountryCode } from "./country-codes.ts";

export const AUTOMATION_MODES = ["manual", "semi", "full"] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export const INTENTS = ["organic", "ad", "both"] as const;
export type Intent = (typeof INTENTS)[number];

export const FORMATS = ["image", "video", "carousel"] as const;
export type Format = (typeof FORMATS)[number];

export const DECISION_ENGINE_CHOICES = ["workspace_default", "jev", "openai-decisions"] as const;
export type DecisionEngineChoice = (typeof DECISION_ENGINE_CHOICES)[number];

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
};

const MAX_PLATFORMS = 8;
const MAX_CENTS = 100_000_000;
const MAX_VARIANTS = 40;
const MAX_TARGETING_COUNTRIES = 25;
const PLATFORM_ID = /^[a-z][a-z_]{1,19}$/;
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
