/**
 * The run builder's rules (NORTH_STAR section 8, item 11). The builder shows every run setting of section 4 and lets a person start a
 * run with them. This module turns the form's draft into the run settings the server validates, and says in plain words why a draft
 * cannot start. It imports nothing that needs the server, so the browser bundle can use it directly. The server checks the same values
 * again (run-settings.ts), so a draft that passes here is still refused there if the server disagrees.
 */

import {
  AUTOMATION_MODES,
  DECISION_ENGINE_CHOICES,
  INTENTS,
  parseRunSettings,
  parseTargetingCountries,
  type AutomationMode,
  type DecisionEngineChoice,
  type Format,
  type Intent,
  type RunSettings,
} from "./run-settings.ts";
import { isCapAmount } from "./cap-amount.ts";

/** What each automation mode does, in the words the stop points use (FACTORY.md, Stop points). */
export const AUTOMATION_DESCRIPTIONS: Record<AutomationMode, string> = {
  manual: "A person approves every step that spends or publishes.",
  semi: "The run does every step and stops for a person before it spends and before it publishes.",
  full: "The run goes end to end inside its spend caps. Gates and the calibration gate still block.",
};

export const INTENT_DESCRIPTIONS: Record<Intent, string> = {
  organic: "Organic posts on the chosen platforms. Learning uses organic outcomes only.",
  ad: "Paused paid ads. Learning uses paid outcomes only.",
  both: "Organic posts and paused ads. Learning does not apply learned patterns to a run with both, because the two surfaces are kept apart.",
};

export const ENGINE_LABELS: Record<DecisionEngineChoice, string> = {
  workspace_default: "The workspace's engine",
  jev: "TypeSafe JEV",
  "openai-decisions": "OpenAI Decisions",
};

export const FORMAT_LABELS: Record<Format, string> = { image: "Image", video: "Video", carousel: "Carousel" };

/** The form's state. Money is typed in dollars; a blank provider means auto. Countries are typed as codes, separated by commas. */
export type BuilderDraft = {
  niche: string;
  automation: AutomationMode;
  decisionEngine: DecisionEngineChoice;
  intent: Intent;
  formats: Format[];
  platforms: string[];
  providers: Partial<Record<Format, string>>;
  dailyDollars: string;
  totalDollars: string;
  maxVariants: string;
  countries: string;
};

/** The draft a run starts from: the brand's run defaults, with an empty niche. */
export function draftFromDefaults(defaults: RunSettings): BuilderDraft {
  return {
    niche: "",
    automation: defaults.automation,
    decisionEngine: defaults.decisionEngine,
    intent: defaults.intent,
    formats: [...defaults.formats],
    platforms: [...defaults.platforms],
    providers: { ...defaults.providers },
    dailyDollars: defaults.caps.dailyCents ? String(defaults.caps.dailyCents / 100) : "",
    totalDollars: defaults.caps.totalCents ? String(defaults.caps.totalCents / 100) : "",
    maxVariants: String(defaults.caps.maxVariants),
    countries: defaults.targetingCountries.join(", "),
  };
}

/**
 * The targeting countries a typed list names. Codes are separated by commas or spaces. A blank list is no countries, which is allowed:
 * a paid publish needs one, and says so. Anything else is refused with the server's own reason.
 */
export function countriesFromText(text: string): { ok: true; value: string[] } | { ok: false; error: string } {
  const tokens = text.split(/[\s,]+/).filter((token) => token !== "");
  return parseTargetingCountries(tokens);
}

/**
 * A plain-words note for a draft that cannot publish a paid ad yet: the intent includes ads and no country is named. It is not a
 * reason the run cannot start. The paid publish refuses with the same reason when it runs.
 */
export function paidCountryNote(intent: Intent, countries: string): string {
  if (intent === "organic") return "";
  // A list that does not parse has its own message, so no second note is shown for it.
  const parsed = countriesFromText(countries);
  if (!parsed.ok || parsed.value.length > 0) return "";
  return "Paid ads are created paused and need a targeting country. Without one, the paid publish is refused with the reason no targeting country.";
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9_:.-]{1,59}$/;

/**
 * Why the draft cannot start, in plain words, in the order a person fixes them. An empty list means the run can be started.
 */
export function draftProblems(draft: BuilderDraft): string[] {
  const problems: string[] = [];
  const niche = draft.niche.trim();
  if (!niche) problems.push("Type a niche, such as skincare, to start a run.");
  if (niche.length > 80) problems.push("The niche is too long. Keep it to 80 characters.");
  return [...problems, ...settingProblems(draft)];
}

/**
 * Why the draft's settings cannot be saved as the brand's defaults, in plain words. The niche is a run's own field, so it is not
 * checked here. An empty list means the settings can be saved.
 */
export function settingProblems(draft: BuilderDraft): string[] {
  const problems: string[] = [];
  if (!(AUTOMATION_MODES as readonly string[]).includes(draft.automation)) problems.push("Choose how the run is automated.");
  if (!(INTENTS as readonly string[]).includes(draft.intent)) problems.push("Choose organic, ad or both.");
  if (!(DECISION_ENGINE_CHOICES as readonly string[]).includes(draft.decisionEngine)) problems.push("Choose a decision engine.");
  if (draft.formats.length === 0) problems.push("Choose at least one format: image, video or carousel.");
  for (const format of draft.formats) {
    const provider = (draft.providers[format] ?? "").trim();
    if (provider && provider !== "auto" && !PROVIDER_ID.test(provider)) {
      problems.push(`The ${FORMAT_LABELS[format].toLowerCase()} provider must be auto or a provider id.`);
    }
  }
  const countries = countriesFromText(draft.countries);
  if (!countries.ok) problems.push(countries.error);
  if (!isCapAmount(draft.dailyDollars)) problems.push("The daily cap must be a dollar amount of 0 or more.");
  if (!isCapAmount(draft.totalDollars)) problems.push("The total cap must be a dollar amount of 0 or more.");
  const variants = Number(draft.maxVariants);
  if (!Number.isInteger(variants) || variants < 1 || variants > 40) problems.push("Max variants per run is a whole number from 1 to 40.");
  const totalCents = centsOf(draft.totalDollars);
  if (draft.automation === "full" && totalCents <= 0) {
    problems.push("Full automation needs a total spend cap above zero. Set one, or choose semi or manual.");
  }
  return problems;
}

/** Dollars typed into a cap as whole cents. A blank cap is zero, which the server reads as no cap. */
function centsOf(dollars: string): number {
  if (dollars.trim() === "") return 0;
  return Math.round(Number(dollars.trim()) * 100);
}

/**
 * The run settings the draft describes. Only call this when draftProblems is empty. A blank provider is auto, and a format the run
 * does not make has no provider entry.
 */
export function settingsFromDraft(draft: BuilderDraft): RunSettings {
  const providers: Partial<Record<Format, string>> = {};
  for (const format of draft.formats) {
    const provider = (draft.providers[format] ?? "").trim();
    providers[format] = provider || "auto";
  }
  // Only called once draftProblems is empty, so a list that does not parse is never sent. A blank list is no countries.
  const countries = countriesFromText(draft.countries);
  return {
    automation: draft.automation,
    decisionEngine: draft.decisionEngine,
    intent: draft.intent,
    formats: [...new Set(draft.formats)],
    platforms: [...new Set(draft.platforms)],
    providers,
    caps: {
      dailyCents: centsOf(draft.dailyDollars),
      totalCents: centsOf(draft.totalDollars),
      maxVariants: Number(draft.maxVariants),
    },
    targetingCountries: countries.ok ? countries.value : [],
  };
}

/**
 * The settings a draft describes, checked by the same rules the server uses. A draft that cannot start returns its problems. The
 * server still checks what it receives, so this is a second check, not the only one.
 */
export function checkedSettings(draft: BuilderDraft): { ok: true; settings: RunSettings } | { ok: false; problems: string[] } {
  const problems = draftProblems(draft);
  if (problems.length > 0) return { ok: false, problems };
  const settings = settingsFromDraft(draft);
  const parsed = parseRunSettings(settings);
  if (!parsed.ok) return { ok: false, problems: [parsed.error] };
  return { ok: true, settings };
}

/**
 * The settings a draft describes, as the brand's run defaults. A niche is not needed for defaults, so only the settings are checked.
 * The server checks the same settings again when they are saved.
 */
export function checkedDefaults(draft: BuilderDraft): { ok: true; settings: RunSettings } | { ok: false; problems: string[] } {
  const problems = settingProblems(draft);
  if (problems.length > 0) return { ok: false, problems };
  const settings = settingsFromDraft(draft);
  const parsed = parseRunSettings(settings);
  if (!parsed.ok) return { ok: false, problems: [parsed.error] };
  return { ok: true, settings };
}
