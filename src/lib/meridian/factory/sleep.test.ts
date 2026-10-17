import assert from "node:assert/strict";
import test from "node:test";
import { tunable } from "../../../engine/config/tunable.ts";
import type { ExecutableJob } from "../jobs/execute.ts";
import type { Sql } from "../learning/store.ts";
import { runSleepNight } from "./sleep.ts";
import type { TunedProposal } from "./sleep-tuning.ts";

const ORG = "org_fixture";
const BRAND = "brand_fixture";
const NOW = new Date("2026-10-15T12:00:00Z");

type Settings = { enabled: boolean; brand_id: string | null; night_time: string; time_zone: string; niche: string; updated_by: string };
type Night = {
  id: string;
  organization_id: string;
  night_key: string;
  status: string;
  reason: string;
  summary: string;
  counts: string;
  failures: string;
  change_budget: string;
};

/**
 * An in-memory stand-in for the statements a sleep night runs before any factory stage. It answers by statement text. The night
 * row keeps the unique rule on (organization, night key), and the night's final update is matched to its row by id.
 */
function fakeSleepDb(options: {
  settings: Settings | null;
  totalCents?: number;
  dailyCents?: number;
  killSwitch?: Array<{ scope: string; engaged: boolean }>;
}) {
  const nights: Night[] = [];
  const scheduleMoves: string[] = [];
  const statement = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").toLowerCase();
    if (text.includes("from sleep_mode_settings")) return options.settings ? [options.settings] : [];
    if (text.includes("update job_schedules")) {
      scheduleMoves.push(String(values[0]));
      return [];
    }
    if (text.includes("insert into sleep_mode_nights")) {
      const [id, organizationId, , nightKey] = values as string[];
      if (nights.some((night) => night.organization_id === organizationId && night.night_key === nightKey)) return [];
      nights.push({
        id,
        organization_id: organizationId,
        night_key: nightKey,
        status: "running",
        reason: "",
        summary: "",
        counts: "",
        failures: "",
        change_budget: "",
      });
      return [{ id }];
    }
    if (text.includes("select status from sleep_mode_nights")) {
      // The night an insert found already there. Values: organization, night key.
      const [organizationId, nightKey] = values as string[];
      const night = nights.find((item) => item.organization_id === organizationId && item.night_key === nightKey);
      return night ? [{ status: night.status }] : [];
    }
    if (text.includes("update sleep_mode_nights set status")) {
      // The night's final record. Values follow the statement: 0 status, 2 reason, 3 summary, 6 counts, 8 failures, 10 change budget, 11 night id.
      const [status, , reason, summary, , , counts, , failures, , changeBudget, nightId] = values as string[];
      const night = nights.find((item) => item.id === nightId);
      if (night) Object.assign(night, { status, reason, summary, counts, failures, change_budget: changeBudget });
      return [];
    }
    if (text.includes("from factory_kill_switches")) return options.killSwitch ?? [];
    if (text.includes("from factory_spend_caps")) {
      return [{ daily_cents: options.dailyCents ?? 0, total_cents: options.totalCents ?? 0 }];
    }
    if (text.includes("from brands")) return [{ run_defaults: "" }];
    if (text.includes("from factory_costs")) return [{ total: 0 }];
    // The brand's engine requests: none, so the engine's spend is nothing (brandCapFiguresOf).
    if (text.includes("from factory_engine_requests")) return [];
    if (text.includes("from factory_settings")) return [];
    throw new Error(`The fake database does not answer this statement: ${text}`);
  };
  return { sql: statement as unknown as Sql, nights, scheduleMoves };
}

function jobFor(brandId: string | null = BRAND): ExecutableJob {
  return {
    id: "job_fixture",
    organization_id: ORG,
    brand_id: brandId,
    job_type: "factory.sleep",
    payload: "{}",
    attempts: 1,
    max_attempts: 3,
  };
}

const ON: Settings = { enabled: true, brand_id: BRAND, night_time: "03:00", time_zone: "UTC", niche: "sleep aids", updated_by: "user_fixture" };

test("with sleep mode off, the night does nothing and writes no record", async () => {
  const db = fakeSleepDb({ settings: { ...ON, enabled: false } });
  assert.equal(await runSleepNight(db.sql, jobFor(), NOW), "sleep:off");
  assert.equal(db.nights.length, 0);
  assert.equal(db.scheduleMoves.length, 0);
});

test("a job for another brand than the one sleep mode is set for does nothing", async () => {
  const db = fakeSleepDb({ settings: ON });
  assert.equal(await runSleepNight(db.sql, jobFor("brand_other"), NOW), "sleep:brand-changed");
  assert.equal(db.nights.length, 0);
});

test("a night with no spend cap records why it did nothing, and starts no run", async () => {
  const db = fakeSleepDb({ settings: ON });
  assert.equal(await runSleepNight(db.sql, jobFor(), NOW), "sleep:stopped");
  assert.equal(db.nights.length, 1);
  assert.equal(db.nights[0]?.night_key, "2026-10-15");
  assert.equal(db.nights[0]?.status, "stopped");
  assert.match(db.nights[0]?.reason ?? "", /No spend cap is set/);
  assert.equal(db.scheduleMoves.length, 1, "the schedule is moved to the next night from this one");
});

test("an engaged kill switch stops the night before anything else is read", async () => {
  const db = fakeSleepDb({ settings: ON, totalCents: 5000, killSwitch: [{ scope: "workspace", engaged: true }] });
  assert.equal(await runSleepNight(db.sql, jobFor(), NOW), "sleep:stopped");
  assert.match(db.nights[0]?.reason ?? "", /kill switch is engaged/);
});

test("a night that has already run for the same local date is not run again", async () => {
  const db = fakeSleepDb({ settings: ON });
  await runSleepNight(db.sql, jobFor(), NOW);
  assert.equal(await runSleepNight(db.sql, jobFor(), NOW), "sleep:already-ran:2026-10-15");
  assert.equal(db.nights.length, 1);
  assert.equal(db.nights[0]?.status, "stopped", "a finished night keeps its status");
});

type ChangeBudget = {
  maxNightlyChangeShare: number;
  tunedValuesAccepted: number;
  tunedValuesRefused: number;
  accepted: Array<{ key: string; from: number; to: number }>;
  refused: Array<{ key: string; proposed: number | null; kept: number; reason: string }>;
  note: string;
};

const CRITIC: TunedProposal = { key: "thresholds.criticConfidence", current: tunable(0.6, 0.3, 0.9), proposed: 0.9 };

test("a night that proposes a tuned change past the nightly cap refuses the excess, and the morning summary says what and why", async () => {
  // No spend cap is set, so the night stops early. Its morning summary still records every tuning decision the night was given.
  const db = fakeSleepDb({ settings: ON });
  assert.equal(await runSleepNight(db.sql, jobFor(), NOW, { tuning: [CRITIC] }), "sleep:stopped");
  const night = db.nights[0];
  assert.match(night?.summary ?? "", /^Stopped: no spend cap is set\. Tuning: /, "the night's own outcome comes first, then the tuning line");
  assert.match(
    night?.summary ?? "",
    /Refused thresholds\.criticConfidence: proposed 0\.9, kept 0\.69, because it moves more than 15% from the current value\./,
    "the refused change, its kept value and the reason are in the morning summary",
  );
  const budget = JSON.parse(night?.change_budget ?? "{}") as ChangeBudget;
  assert.equal(budget.maxNightlyChangeShare, 0.15);
  assert.equal(budget.tunedValuesRefused, 1);
  assert.equal(budget.tunedValuesAccepted, 0);
  assert.equal(budget.refused[0]?.key, "thresholds.criticConfidence");
  assert.equal(budget.refused[0]?.proposed, 0.9);
  assert.equal(budget.refused[0]?.kept, 0.69);
});

test("a tuned change inside the nightly cap is accepted, and nothing is refused", async () => {
  const db = fakeSleepDb({ settings: ON });
  const inside: TunedProposal = { ...CRITIC, proposed: 0.65 };
  await runSleepNight(db.sql, jobFor(), NOW, { tuning: [inside] });
  const night = db.nights[0];
  assert.match(night?.summary ?? "", /Tuning: 1 proposed change inside the 15% nightly cap, 0 refused\./);
  assert.doesNotMatch(night?.summary ?? "", /Refused /);
  const budget = JSON.parse(night?.change_budget ?? "{}") as ChangeBudget;
  assert.deepEqual(budget.accepted, [{ key: "thresholds.criticConfidence", from: 0.6, to: 0.65 }]);
  assert.equal(budget.tunedValuesRefused, 0);
  assert.match(budget.note, /recorded here only/, "an accepted change is recorded, and sleep mode writes no engine config");
});

test("a night with no tuned proposal says the cap was not used, and its summary says nothing about tuning", async () => {
  const db = fakeSleepDb({ settings: ON });
  await runSleepNight(db.sql, jobFor(), NOW);
  const night = db.nights[0];
  assert.doesNotMatch(night?.summary ?? "", /Tuning:/);
  const budget = JSON.parse(night?.change_budget ?? "{}") as ChangeBudget;
  assert.equal(budget.tunedValuesAccepted, 0);
  assert.equal(budget.tunedValuesRefused, 0);
  assert.equal(budget.note, "No tuned value was proposed tonight, so the nightly change cap was not used.");
});
