/**
 * Theme pages (NORTH_STAR section 8, item B3), pure part. A theme page is the account-level object a Factory run can target: its linked
 * platform account, its persona, voice and style kits, its posting schedule, and whether its Instagram posts start as a trial reel.
 *
 * This module validates what a person typed, checks that the fields hold together, and maps a stored page to the engine's request
 * fields. It reads and writes nothing. The store is in store.ts, and the server functions are in actions.ts.
 *
 * Unknown stays null. A posting schedule with no time zone is refused, not given UTC. A trial first with no graduation strategy is
 * refused, not given one. An empty schedule is stored as no schedule.
 */
import { TRIAL_GRADUATION_STRATEGIES, type TrialGraduationStrategy, type TrialRequest } from "../distribution/trial.ts";

export const PAGE_PLATFORMS = ["instagram", "facebook", "youtube", "tiktok"] as const;
export type PagePlatform = (typeof PAGE_PLATFORMS)[number];

/** The statuses a person sets on the page. Archiving is its own action, so an edit never retires a page. */
export const EDITABLE_PAGE_STATUSES = ["active", "paused"] as const;
export type EditablePageStatus = (typeof EDITABLE_PAGE_STATUSES)[number];
export type PageStatus = EditablePageStatus | "archived";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Local times per weekday, as HH:MM in 24-hour time in the page's time zone. A day with no times is absent. */
export type PostingTimes = Partial<Record<Weekday, string[]>>;

export const MAX_TIMES_PER_DAY = 12;
const MAX_NAME = 80;
const MAX_NICHE = 80;
const MAX_REFERENCE = 120;
const MAX_ZONE = 64;
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export type ThemePageFields = {
  name: string;
  niche: string | null;
  platform: PagePlatform;
  platformAccountId: string | null;
  personaKitId: string | null;
  voiceKitId: string | null;
  styleKitId: string | null;
  postingTimeZone: string | null;
  postingTimes: PostingTimes | null;
  trialFirst: boolean;
  trialGraduation: TrialGraduationStrategy | null;
  status: PageStatus;
};

/** The fields the engine's request takes from a page (request.page in contracts/request.ts). Null means the page does not set it. */
export type PageRequestKits = {
  pageId: string;
  styleKitId: string | null;
  personaId: string | null;
  voiceId: string | null;
};

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isPagePlatform(value: unknown): value is PagePlatform {
  return typeof value === "string" && (PAGE_PLATFORMS as readonly string[]).includes(value);
}

function isGraduation(value: unknown): value is TrialGraduationStrategy {
  return typeof value === "string" && (TRIAL_GRADUATION_STRATEGIES as readonly string[]).includes(value);
}

/** True when the runtime knows the zone. An unknown name, such as Mars/Olympus, is not guessed at. */
export function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Trimmed text of a given length at most. Anything that is not text is refused with the label. */
function trimmedText(value: unknown, label: string, max: number): Result<string> {
  if (typeof value !== "string") return fail(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) return fail(`${label} is at most ${max} characters.`);
  return { ok: true, value: trimmed };
}

/** Text, or null when it is empty. An empty field is unknown, not a blank value. */
function optionalText(value: unknown, label: string, max: number): Result<string | null> {
  if (value === null) return { ok: true, value: null };
  const text = trimmedText(value, label, max);
  if (!text.ok) return text;
  return { ok: true, value: text.value === "" ? null : text.value };
}

/**
 * The posting schedule as a stored value. Null, or an object with a list of times for some weekdays. Times are HH:MM, sorted and
 * without duplicates. A day with no times is dropped, and a schedule with no times at all is null.
 */
export function parsePostingTimes(input: unknown): Result<PostingTimes | null> {
  if (input === null) return { ok: true, value: null };
  if (!isRecord(input)) return fail("The posting times must be a list of times for each weekday.");
  const times: PostingTimes = {};
  for (const [day, list] of Object.entries(input)) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) {
      return fail(`${day} is not a weekday. Use ${WEEKDAYS.join(", ")}.`);
    }
    if (!Array.isArray(list)) return fail(`The times for ${day} must be a list of HH:MM times.`);
    if (list.length > MAX_TIMES_PER_DAY) return fail(`Choose at most ${MAX_TIMES_PER_DAY} times for ${day}.`);
    const dayTimes: string[] = [];
    for (const item of list) {
      if (typeof item !== "string" || !TIME_OF_DAY.test(item)) {
        return fail(`A posting time for ${day} must be HH:MM in 24-hour time, such as 09:30.`);
      }
      if (!dayTimes.includes(item)) dayTimes.push(item);
    }
    dayTimes.sort();
    if (dayTimes.length > 0) times[day as Weekday] = dayTimes;
  }
  return { ok: true, value: Object.keys(times).length === 0 ? null : times };
}

/**
 * Checks the fields a person sent. Only the keys present are checked, so an edit sends only what changed. Each unknown or wrong value is
 * refused with the reason, and nothing is coerced. The cross-field rules are in pageFieldsProblem.
 */
export function parseThemePageFields(input: unknown): Result<Partial<ThemePageFields>> {
  if (!isRecord(input)) return fail("The page must be an object.");
  const value: Partial<ThemePageFields> = {};

  if (input.name !== undefined) {
    const name = trimmedText(input.name, "The page name", MAX_NAME);
    if (!name.ok) return name;
    if (name.value === "") return fail("The page needs a name.");
    value.name = name.value;
  }
  if (input.niche !== undefined) {
    const niche = optionalText(input.niche, "The niche", MAX_NICHE);
    if (!niche.ok) return niche;
    value.niche = niche.value;
  }
  if (input.platform !== undefined) {
    if (!isPagePlatform(input.platform)) return fail(`The platform must be ${PAGE_PLATFORMS.join(", ")}.`);
    value.platform = input.platform as PagePlatform;
  }
  if (input.platformAccountId !== undefined) {
    const account = optionalText(input.platformAccountId, "The linked account", MAX_REFERENCE);
    if (!account.ok) return account;
    value.platformAccountId = account.value;
  }
  if (input.personaKitId !== undefined) {
    const kit = optionalText(input.personaKitId, "The persona kit", MAX_REFERENCE);
    if (!kit.ok) return kit;
    value.personaKitId = kit.value;
  }
  if (input.voiceKitId !== undefined) {
    const kit = optionalText(input.voiceKitId, "The voice kit", MAX_REFERENCE);
    if (!kit.ok) return kit;
    value.voiceKitId = kit.value;
  }
  if (input.styleKitId !== undefined) {
    const kit = optionalText(input.styleKitId, "The style kit", MAX_REFERENCE);
    if (!kit.ok) return kit;
    value.styleKitId = kit.value;
  }
  if (input.postingTimeZone !== undefined) {
    const zone = optionalText(input.postingTimeZone, "The time zone", MAX_ZONE);
    if (!zone.ok) return zone;
    if (zone.value !== null && !isIanaTimeZone(zone.value)) {
      return fail(`${zone.value} is not a time zone name. Use a name such as Europe/London or America/New_York.`);
    }
    value.postingTimeZone = zone.value;
  }
  if (input.postingTimes !== undefined) {
    const times = parsePostingTimes(input.postingTimes);
    if (!times.ok) return times;
    value.postingTimes = times.value;
  }
  if (input.trialFirst !== undefined) {
    if (typeof input.trialFirst !== "boolean") return fail("Trial first must be on or off.");
    value.trialFirst = input.trialFirst;
  }
  if (input.trialGraduation !== undefined) {
    if (input.trialGraduation !== null && !isGraduation(input.trialGraduation)) {
      return fail(`The trial graduation must be ${TRIAL_GRADUATION_STRATEGIES.join(" or ")}, or none.`);
    }
    value.trialGraduation = input.trialGraduation as TrialGraduationStrategy | null;
  }
  if (input.status !== undefined) {
    if (!(EDITABLE_PAGE_STATUSES as readonly unknown[]).includes(input.status)) {
      return fail("The status must be active or paused. Archive a page to retire it.");
    }
    value.status = input.status as EditablePageStatus;
  }
  return { ok: true, value };
}

/** A new page: the name and the platform are required, and every other field starts unknown (null) or off. */
export function parseNewThemePage(input: unknown): Result<ThemePageFields> {
  const parsed = parseThemePageFields(input);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (value.name === undefined) return fail("The page needs a name.");
  if (value.platform === undefined) return fail("Choose the platform for the page.");
  return {
    ok: true,
    value: {
      name: value.name,
      niche: value.niche ?? null,
      platform: value.platform,
      platformAccountId: value.platformAccountId ?? null,
      personaKitId: value.personaKitId ?? null,
      voiceKitId: value.voiceKitId ?? null,
      styleKitId: value.styleKitId ?? null,
      postingTimeZone: value.postingTimeZone ?? null,
      postingTimes: value.postingTimes ?? null,
      trialFirst: value.trialFirst ?? false,
      trialGraduation: value.trialGraduation ?? null,
      status: value.status ?? "active",
    },
  };
}

/**
 * Why the fields do not hold together, or null. A posting schedule needs its time zone, and no zone is assumed. Trial first needs a
 * graduation strategy: MANUAL means a person graduates the reel in the Instagram app, and SS_PERFORMANCE means Instagram does.
 */
export function pageFieldsProblem(
  fields: Pick<ThemePageFields, "postingTimes" | "postingTimeZone" | "trialFirst" | "trialGraduation">,
): string | null {
  if (fields.postingTimes && !fields.postingTimeZone) {
    return "A posting schedule needs a time zone, such as Europe/London. No time zone is assumed.";
  }
  if (fields.trialFirst && !fields.trialGraduation) {
    return "Trial first needs a graduation strategy: MANUAL (a person graduates the reel in the Instagram app) or SS_PERFORMANCE (Instagram graduates it when it performs).";
  }
  return null;
}

/** The request.page fields for a page. Kit ids the page does not set stay null, and the engine schema then reports them as missing. */
export function pageRequestKits(page: Pick<ThemePageFields, "styleKitId" | "personaKitId" | "voiceKitId"> & { id: string }): PageRequestKits {
  return {
    pageId: page.id,
    styleKitId: page.styleKitId,
    personaId: page.personaKitId,
    voiceId: page.voiceKitId,
  };
}

/** The trial a page makes by default: a trial first with its graduation strategy, or null for an ordinary publish. */
export function trialChoiceFor(page: Pick<ThemePageFields, "trialFirst" | "trialGraduation">): TrialRequest | null {
  if (!page.trialFirst || !page.trialGraduation) return null;
  return { graduationStrategy: page.trialGraduation };
}

/** The stored schedule, checked on the way out. A value that is not a valid schedule is read as no schedule, never as a guess. */
export function storedPostingTimes(value: unknown): PostingTimes | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  const checked = parsePostingTimes(parsed);
  return checked.ok ? checked.value : null;
}
