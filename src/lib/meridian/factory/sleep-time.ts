/**
 * Local night times for sleep mode, in a named IANA time zone. Pure, with Intl only. A night is the local time the workspace
 * chose, so a daylight-saving change moves the next run to the same local time, not the same number of hours.
 */

/** The job type the sleep schedule enqueues. execute.ts routes it to runSleepNight. */
export const SLEEP_JOB_TYPE = "factory.sleep";

/** One schedule row per workspace, so the schedule and the setting are found from the organization. */
export function sleepScheduleIdOf(organizationId: string): string {
  return `sleep:${organizationId}`;
}

const NIGHT_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** HH:MM on a 24-hour clock, such as 03:00. Null for anything else. */
export function parseNightTime(value: string): { hour: number; minute: number } | null {
  const match = NIGHT_TIME.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Whether the value is an IANA time zone the runtime knows, such as Europe/London. UTC is accepted. */
export function isValidTimeZone(value: string): boolean {
  const zone = value.trim();
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function localPartsOf(date: Date, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some runtimes report midnight as 24 even with a 23-hour clock. The modulo keeps it at 0.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The zone's offset from UTC at this instant, in milliseconds: its wall-clock reading minus UTC. */
function offsetAt(date: Date, timeZone: string): number {
  const p = localPartsOf(date, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant at which the zone's clock reads this local date and time. Two passes settle the offset across a change. */
function instantOfLocal(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstGuess = wall - offsetAt(new Date(wall), timeZone);
  return new Date(wall - offsetAt(new Date(firstGuess), timeZone));
}

/**
 * The next instant the local night time occurs after `now`. If today's time has not yet come, it is today's. Otherwise it is
 * tomorrow's. Throws for a time that is not HH:MM or a zone that is not known, so a bad setting never schedules a run.
 */
export function nextNightAt(now: Date, time: string, timeZone: string): Date {
  const hm = parseNightTime(time);
  if (!hm) throw new Error("The night time must be HH:MM on a 24-hour clock, such as 03:00.");
  if (!isValidTimeZone(timeZone)) throw new Error("The time zone must be a known IANA zone, such as Europe/London or UTC.");
  const today = localPartsOf(now, timeZone);
  const candidate = instantOfLocal(today.year, today.month, today.day, hm.hour, hm.minute, timeZone);
  if (candidate.getTime() > now.getTime()) return candidate;
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return instantOfLocal(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    hm.hour,
    hm.minute,
    timeZone,
  );
}

/** The local calendar date of an instant, as YYYY-MM-DD. A night is keyed by this date, so it runs once. */
export function localDateKey(now: Date, timeZone: string): string {
  const p = localPartsOf(now, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
