import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { requireBrand } from "@/lib/meridian/brand-membership";
import type { Sql } from "../learning/store.ts";
import type { NightSource } from "./sleep.ts";
import { isValidTimeZone, nextNightAt, parseNightTime, SLEEP_JOB_TYPE, sleepScheduleIdOf } from "./sleep-time.ts";

/** The nightly schedule runs once a day. Its local time is kept by re-anchoring it after each night (sleep.ts). */
const EVERY_SECONDS = 86400;
const NIGHTS_SHOWN = 14;

function clip(value: unknown, max: number, label: string, required = false): string {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return "";
    throw new Error(`${label} must be text.`);
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${label} is required.`);
  if (trimmed.length > max) throw new Error(`${label} is too long.`);
  return trimmed;
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid request.");
  return input as Record<string, unknown>;
}

export type SleepSettingsView = {
  brandId: string;
  enabled: boolean;
  nightTime: string;
  timeZone: string;
  niche: string;
};

/** One morning summary, read from the stored night. The JSON columns are parsed, and a value that cannot be read is empty. */
export type SleepNightView = {
  id: string;
  nightKey: string;
  status: string;
  reason: string;
  summary: string;
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  counts: Record<string, number>;
  sources: NightSource[];
  failures: string[];
  holdoutItemIds: string[];
};

export type SleepModeView = {
  settings: SleepSettingsView | null;
  /** The next night, as an ISO time, when sleep mode is on. Null otherwise. */
  nextRun: string | null;
  nights: SleepNightView[];
};

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

type NightRow = {
  id: string;
  night_key: string;
  status: string;
  reason: string;
  summary: string;
  run_id: string;
  started_at: unknown;
  finished_at: unknown;
  counts: string;
  sources: string;
  failures: string;
  holdout_item_ids: string;
};

function nightOf(row: NightRow): SleepNightView {
  const counts = parseJson<Record<string, unknown>>(row.counts, {});
  const numeric: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === "number" && Number.isFinite(value)) numeric[key] = value;
  }
  return {
    id: row.id,
    nightKey: row.night_key,
    status: row.status,
    reason: row.reason,
    summary: row.summary,
    runId: row.run_id,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    counts: numeric,
    sources: parseJson<NightSource[]>(row.sources, []),
    failures: parseJson<string[]>(row.failures, []),
    holdoutItemIds: parseJson<string[]>(row.holdout_item_ids, []),
  };
}

/** The brand's sleep-mode setting, its next night, and its last mornings. Readable by every member of the brand. */
export const getSleepMode = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: clip(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<SleepModeView> => {
    const sql = await getSql();
    const { organizationId } = await requireBrand(sql, context.userId, data.brandId, "viewer");
    const settingsRows = await sql<{ enabled: boolean; brand_id: string | null; night_time: string; time_zone: string; niche: string }>`
      select enabled, brand_id, night_time, time_zone, niche from sleep_mode_settings
      where organization_id = ${organizationId}
      limit 1
    `;
    const row = settingsRows[0];
    // The setting belongs to one brand. Another brand's setting is not shown here.
    const settings = row && row.brand_id === data.brandId
      ? { brandId: data.brandId, enabled: row.enabled, nightTime: row.night_time, timeZone: row.time_zone, niche: row.niche }
      : null;
    const schedule = await sql<{ next_run: unknown; enabled: boolean }>`
      select next_run, enabled from job_schedules
      where id = ${sleepScheduleIdOf(organizationId)} and organization_id = ${organizationId}
      limit 1
    `;
    const nights = await sql<NightRow>`
      select id, night_key, status, reason, summary, run_id, started_at, finished_at, counts, sources, failures, holdout_item_ids
      from sleep_mode_nights
      where organization_id = ${organizationId} and brand_id = ${data.brandId}
      order by started_at desc
      limit ${NIGHTS_SHOWN}
    `;
    const next = schedule[0];
    return {
      settings,
      nextRun: settings?.enabled && next?.enabled ? String(next.next_run) : null,
      nights: nights.map(nightOf),
    };
  });

/**
 * Turns sleep mode on or off for the workspace, for one brand. Only an admin can change it. On, the nightly schedule is written
 * (or moved) to the next local night time. Off, the schedule is disabled, and a night that is due does nothing.
 */
export const saveSleepMode = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return {
      brandId: clip(body.brandId, 80, "Brand", true),
      enabled: body.enabled === true,
      nightTime: clip(body.nightTime, 5, "Night time", true),
      timeZone: clip(body.timeZone, 64, "Time zone", true),
      niche: clip(body.niche, 80, "Niche"),
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const { organizationId } = await requireBrand(sql, context.userId, data.brandId, "admin");
    if (!parseNightTime(data.nightTime)) throw new Error("The night time must be HH:MM on a 24-hour clock, such as 03:00.");
    if (!isValidTimeZone(data.timeZone)) throw new Error("Choose a known time zone, such as Europe/London or UTC.");
    if (data.enabled && !data.niche) throw new Error("Sleep mode needs a niche to gather. Enter one, then turn sleep mode on.");

    await sql`
      insert into sleep_mode_settings (organization_id, brand_id, enabled, night_time, time_zone, niche, updated_by, updated_at)
      values (${organizationId}, ${data.brandId}, ${data.enabled}, ${data.nightTime}, ${data.timeZone}, ${data.niche}, ${context.userId}, now())
      on conflict (organization_id) do update set
        brand_id = excluded.brand_id,
        enabled = excluded.enabled,
        night_time = excluded.night_time,
        time_zone = excluded.time_zone,
        niche = excluded.niche,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `;

    if (data.enabled) {
      const next = nextNightAt(new Date(), data.nightTime, data.timeZone).toISOString();
      await sql`
        insert into job_schedules (id, organization_id, brand_id, job_type, every_seconds, next_run, enabled, payload)
        values (${sleepScheduleIdOf(organizationId)}, ${organizationId}, ${data.brandId}, ${SLEEP_JOB_TYPE}, ${EVERY_SECONDS}, ${next}, true, '{}')
        on conflict (id) do update set
          brand_id = excluded.brand_id,
          every_seconds = excluded.every_seconds,
          next_run = excluded.next_run,
          enabled = true
      `;
      return { ok: true as const, nextRun: next };
    }
    await disableSchedule(sql, organizationId);
    return { ok: true as const, nextRun: null };
  });

async function disableSchedule(sql: Sql, organizationId: string): Promise<void> {
  await sql`
    update job_schedules set enabled = false
    where id = ${sleepScheduleIdOf(organizationId)} and organization_id = ${organizationId}
  `;
}
