// Factory Gather, Instagram volume (B1 and B2, NORTH_STAR section 5, step 1 and step 2).
//
// One gather run asks Apify for about 1,000 Instagram reel candidates per niche per week (INSTAGRAM_VOLUME_CONFIG), stores
// each one with its creator's baseline, and rates it (tiers S to C, or "not rated" with the reason). The 0-hour checkpoint is
// the observation this run made; the +24 h and +72 h checkpoints are scheduled through the job queue and taken later.
//
// Fail closed: with no Apify key the source is not_connected and nothing is sent. A failed request is failed, and the run goes
// on with what it has. The caps are counts of results asked of Apify, written before each request, so they are hard limits.

import type { Sql } from "../learning/store.ts";
import { upsertCreatorProfile } from "../organic/creators.ts";
import { recordCreatorSnapshot, reusableBaseline, type CreatorBaselineStatus } from "../organic/creator-snapshots.ts";
import {
  hoursSincePosted,
  insertReelCandidate,
  observedPoints,
  recordReelRating,
  reserveVolumeRequest,
  scheduleReelSnapshots,
  setReelBaseline,
  settleVolumeRequest,
  upsertReelSnapshot,
  volumeResultsThisWeek,
} from "../organic/reel-store.ts";
import { rateReel } from "../grading/reel-rating.ts";
import type { ApifyClient } from "../sources/apify/client.ts";
import { INSTAGRAM_VOLUME_CONFIG } from "../sources/apify/config.ts";
import {
  creatorBaseline,
  creatorReelsInput,
  hashtagInput,
  nicheHashtags,
  parseReelItem,
  reelKey,
  type ReelCandidate,
} from "../sources/apify/instagram-volume.ts";

export type VolumeState = "ok" | "not_connected" | "failed";

/** The source's state on the run. `items` counts the candidates stored as new by this run. */
export type VolumeGather = { state: VolumeState; reason: string; items: number };

export type InstagramVolumeInput = {
  organizationId: string;
  brandId: string;
  runId: string;
  niche: string;
  /** The clock. Tests pass a fixed one. */
  now?: () => Date;
  /**
   * The weekly cap, in results asked of Apify. Unset, the run uses INSTAGRAM_VOLUME_CONFIG.candidatesPerWeek. Only tests pass another
   * value; the factory run does not.
   */
  weeklyCap?: number;
};

type Baseline = { median: number | null; reason: string };

function capReason(weeklyCap: number): string {
  return `The weekly limit of ${weeklyCap} Apify results for this niche is used.`;
}

/** Splits a total into parts that add up to it exactly; the first parts take any remainder. */
export function splitEvenly(total: number, parts: number): number[] {
  if (parts <= 0) return [];
  const base = Math.floor(total / parts);
  const remainder = total % parts;
  return Array.from({ length: parts }, (_, index) => base + (index < remainder ? 1 : 0));
}

function handleKey(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

/**
 * Returns each creator's baseline. A baseline measured in the last few days is reused, so a creator is not fetched twice in a
 * week. At most `maxCreatorBaselinesPerRun` creators are fetched in one run; the rest are not rated in it, and the reason says so.
 */
async function baselinesFor(
  sql: Sql,
  input: InstagramVolumeInput,
  client: ApifyClient,
  handles: readonly string[],
  weeklyCap: number,
): Promise<Map<string, Baseline>> {
  const config = INSTAGRAM_VOLUME_CONFIG;
  const result = new Map<string, Baseline>();
  let fetched = 0;
  for (const handle of handles) {
    const key = handleKey(handle);
    if (result.has(key)) continue;
    const creatorId = (await upsertCreatorProfile(sql, { organizationId: input.organizationId, platform: "instagram", handle: key })).id;

    const reusable = await reusableBaseline(sql, input.organizationId, creatorId, config.baselineReuseDays);
    if (reusable) {
      result.set(key, { median: reusable.medianViews === null ? null : Number(reusable.medianViews), reason: reusable.baselineReason });
      continue;
    }
    if (fetched >= config.maxCreatorBaselinesPerRun) {
      result.set(key, {
        median: null,
        reason: `This run fetches the baselines of ${config.maxCreatorBaselinesPerRun} creators. This creator's baseline is fetched in a later run.`,
      });
      continue;
    }

    // The baseline's results are reserved under the weekly cap before the call is sent. A refused baseline is not sent.
    const requestId = await reserveVolumeRequest(sql, {
      organizationId: input.organizationId,
      brandId: input.brandId,
      runId: input.runId,
      niche: input.niche,
      purpose: "baseline",
      actorId: config.actors.creator,
      requestedResults: config.creatorBaselineReels,
      weeklyCap,
    });
    if (requestId === null) {
      result.set(key, { median: null, reason: `${capReason(weeklyCap)} This creator's baseline was not fetched, and no Apify call was made.` });
      continue;
    }
    fetched += 1;

    const answer = await client.runSync({
      organizationId: input.organizationId,
      actorId: config.actors.creator,
      input: creatorReelsInput(key, config.creatorBaselineReels),
      maxItems: config.creatorBaselineReels,
    });
    if (answer.status !== "ok") {
      await settleVolumeRequest(sql, {
        organizationId: input.organizationId,
        requestId,
        status: answer.status,
        returnedItems: null,
        reason: answer.reason,
      });
      await recordCreatorSnapshot(sql, {
        creatorId,
        organizationId: input.organizationId,
        baselineStatus: "failed",
        baselineReason: answer.reason,
      });
      result.set(key, { median: null, reason: answer.reason });
      continue;
    }
    await settleVolumeRequest(sql, {
      organizationId: input.organizationId,
      requestId,
      status: "ok",
      returnedItems: answer.items.length,
      reason: "",
    });
    const reels = answer.items.map(parseReelItem).filter((reel): reel is ReelCandidate => reel !== null);
    const baseline = creatorBaseline(reels, key);
    const status: CreatorBaselineStatus = baseline.status === "measured" ? "measured" : "insufficient";
    await recordCreatorSnapshot(sql, {
      creatorId,
      organizationId: input.organizationId,
      medianViews: baseline.median,
      reelSampleSize: baseline.sampleSize,
      baselineStatus: status,
      baselineReason: baseline.reason,
    });
    result.set(key, { median: baseline.median, reason: baseline.reason });
  }
  return result;
}

/**
 * Gathers one run's Instagram candidates. Returns the state the run shows for the source; it throws only when the database cannot
 * be written, and the caller records that as a failed source.
 */
export async function gatherInstagramVolume(sql: Sql, input: InstagramVolumeInput, client: ApifyClient): Promise<VolumeGather> {
  const config = INSTAGRAM_VOLUME_CONFIG;
  const terms = nicheHashtags(input.niche);
  if (terms.length === 0) {
    return { state: "failed", reason: "The run has no niche keyword to search Instagram for.", items: 0 };
  }

  const connection = await client.connection(input.organizationId);
  if (!connection.connected) {
    return { state: "not_connected", reason: connection.reason ?? "Apify is not connected, so no Instagram candidates were gathered.", items: 0 };
  }

  // The limit is read here only to size this run. Each call below reserves its own results under the cap before it is sent, so the
  // cap holds even when another gather runs at the same time.
  const weeklyCap = input.weeklyCap ?? config.candidatesPerWeek;
  const used = await volumeResultsThisWeek(sql, input.organizationId, input.niche);
  const remaining = weeklyCap - used;
  if (remaining <= 0) {
    return {
      state: "ok",
      reason: `${capReason(weeklyCap)} ${used} results were asked for in the last seven days. No Apify call was made.`,
      items: 0,
    };
  }
  const runLimit = Math.min(config.candidatesPerRun, remaining);

  const found: ReelCandidate[] = [];
  const failures: string[] = [];
  const capped: string[] = [];
  const shares = splitEvenly(runLimit, terms.length);
  for (let index = 0; index < terms.length; index += 1) {
    const share = shares[index] ?? 0;
    if (share <= 0) continue;
    const requestId = await reserveVolumeRequest(sql, {
      organizationId: input.organizationId,
      brandId: input.brandId,
      runId: input.runId,
      niche: input.niche,
      purpose: "candidates",
      actorId: config.actors.niche,
      requestedResults: share,
      weeklyCap,
    });
    if (requestId === null) {
      capped.push(`#${terms[index]}: ${capReason(weeklyCap)} No Apify call was made.`);
      continue;
    }
    const answer = await client.runSync({
      organizationId: input.organizationId,
      actorId: config.actors.niche,
      input: hashtagInput(terms[index], share),
      maxItems: share,
    });
    if (answer.status !== "ok") {
      await settleVolumeRequest(sql, {
        organizationId: input.organizationId,
        requestId,
        status: answer.status,
        returnedItems: null,
        reason: answer.reason,
      });
      if (answer.status === "not_connected") {
        return { state: "not_connected", reason: answer.reason, items: 0 };
      }
      failures.push(`#${terms[index]}: ${answer.reason}`);
      continue;
    }
    await settleVolumeRequest(sql, {
      organizationId: input.organizationId,
      requestId,
      status: "ok",
      returnedItems: answer.items.length,
      reason: "",
    });
    for (const raw of answer.items) {
      const candidate = parseReelItem(raw);
      if (candidate && candidate.isVideo) found.push(candidate);
    }
  }

  // One reel per address, however the search reached it, and never more than this run's share.
  const unique = new Map<string, ReelCandidate>();
  for (const candidate of found) {
    const key = reelKey(candidate.permalink);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  const candidates = [...unique.values()].slice(0, runLimit);

  const discoveredAt = (input.now ?? (() => new Date()))().toISOString();
  const fresh: Array<{ id: string; candidate: ReelCandidate }> = [];
  for (const candidate of candidates) {
    const id = await insertReelCandidate(sql, {
      organizationId: input.organizationId,
      brandId: input.brandId,
      runId: input.runId,
      niche: input.niche,
      actorId: config.actors.niche,
      discoveredAt,
      candidate,
    });
    if (id) fresh.push({ id, candidate });
  }

  const baselines = await baselinesFor(
    sql,
    input,
    client,
    fresh.map((entry) => entry.candidate.creatorHandle),
    weeklyCap,
  );
  for (const { id, candidate } of fresh) {
    const baseline = baselines.get(handleKey(candidate.creatorHandle)) ?? {
      median: null,
      reason: "The creator's baseline was not measured.",
    };
    await setReelBaseline(sql, {
      organizationId: input.organizationId,
      reelId: id,
      medianViews: baseline.median,
      reason: baseline.reason,
    });
    // The 0-hour checkpoint is what this run saw. Its time is the discovery time, the origin of the later checkpoints.
    await upsertReelSnapshot(sql, {
      organizationId: input.organizationId,
      reelId: id,
      checkpointHours: 0,
      hoursSincePost: hoursSincePosted(candidate.postedAt, discoveredAt),
      views: candidate.views,
      likes: candidate.likes,
      comments: candidate.comments,
      capturedAt: discoveredAt,
    });
    const outcome = rateReel({
      creatorMedianViews: baseline.median,
      baselineReason: baseline.reason,
      snapshots: await observedPoints(sql, input.organizationId, id),
    });
    await recordReelRating(sql, {
      organizationId: input.organizationId,
      reelId: id,
      checkpointHours: 0,
      outcome,
      creatorMedianViews: baseline.median,
    });
    await scheduleReelSnapshots(sql, {
      organizationId: input.organizationId,
      brandId: input.brandId,
      reelId: id,
      discoveredAt,
    });
  }

  const reasons: string[] = [];
  if (failures.length > 0) reasons.push(failures.join(" "));
  if (capped.length > 0) reasons.push(capped.join(" "));
  if (candidates.length === 0 && failures.length === 0 && capped.length === 0) {
    reasons.push("Instagram returned no video candidates for this niche.");
  }
  return {
    state: failures.length > 0 ? "failed" : "ok",
    reason: reasons.join(" "),
    items: fresh.length,
  };
}
