// The organic.reel_snapshot job (B2): takes one checkpoint of a stored reel, +24 h or +72 h after discovery, and re-rates it.
//
// The job is scheduled by the gather run (reel-store.ts scheduleReelSnapshots) and runs at its time through the job queue.
// The reading comes from Apify's reel actor, by the reel's own address. A failed or unconnected request throws, so the job
// shows as failed and is retried; a checkpoint is stored only when its view and comment counts were returned.

import type { Sql } from "../learning/store.ts";
import { rateReel } from "../grading/reel-rating.ts";
import { liveApifyClient, type ApifyClient } from "../sources/apify/client.ts";
import { INSTAGRAM_VOLUME_CONFIG } from "../sources/apify/config.ts";
import { parseReelItem, reelKey, reelUrlInput, type ReelCandidate } from "../sources/apify/instagram-volume.ts";
import {
  hoursSincePosted,
  loadReel,
  newVolumeRequest,
  observedPoints,
  recordReelRating,
  settleVolumeRequest,
  upsertReelSnapshot,
  type StoredReel,
} from "./reel-store.ts";

export type ReelSnapshotJob = { id: string; organization_id: string; brand_id: string | null };

/** Whether an item returned for the reel is that reel: the same address, or the same Apify id. */
function isSameReel(candidate: ReelCandidate, reel: StoredReel): boolean {
  if (reelKey(candidate.permalink) === reelKey(reel.permalink)) return true;
  return candidate.externalId !== null && reel.externalPostId !== null && candidate.externalId === reel.externalPostId;
}

/** Runs one checkpoint job. Returns a summary of what was stored; throws when nothing could be observed. */
export async function executeReelSnapshot(
  sql: Sql,
  job: ReelSnapshotJob,
  payload: Record<string, unknown>,
  client: ApifyClient = liveApifyClient(),
  now: () => Date = () => new Date(),
): Promise<string> {
  const reelId = typeof payload.reelId === "string" ? payload.reelId : "";
  const checkpoint = payload.checkpointHours === 24 || payload.checkpointHours === 72 ? payload.checkpointHours : null;
  if (!reelId || checkpoint === null) {
    throw new Error("A reel snapshot needs a stored reel and a 24 or 72 hour checkpoint.");
  }
  const reel = await loadReel(sql, job.organization_id, reelId);
  if (!reel) return "missing-reel";

  const connection = await client.connection(job.organization_id);
  if (!connection.connected) {
    throw new Error(connection.reason ?? "Apify is not connected, so this checkpoint was not taken.");
  }

  const requestId = await newVolumeRequest(sql, {
    organizationId: job.organization_id,
    brandId: reel.brandId,
    runId: null,
    niche: reel.niche,
    purpose: "snapshot",
    actorId: INSTAGRAM_VOLUME_CONFIG.actors.creator,
    requestedResults: 1,
  });
  const answer = await client.runSync({
    organizationId: job.organization_id,
    actorId: INSTAGRAM_VOLUME_CONFIG.actors.creator,
    input: reelUrlInput(reel.permalink),
    maxItems: 1,
  });
  if (answer.status !== "ok") {
    await settleVolumeRequest(sql, {
      organizationId: job.organization_id,
      requestId,
      status: answer.status,
      returnedItems: null,
      reason: answer.reason,
    });
    throw new Error(answer.reason);
  }
  await settleVolumeRequest(sql, {
    organizationId: job.organization_id,
    requestId,
    status: "ok",
    returnedItems: answer.items.length,
    reason: "",
  });

  const readings = answer.items.map(parseReelItem).filter((item): item is ReelCandidate => item !== null);
  const match = readings.find((candidate) => isSameReel(candidate, reel));
  if (!match) {
    throw new Error("Apify returned no item for this reel, so no checkpoint was stored.");
  }

  const capturedAt = now().toISOString();
  await upsertReelSnapshot(sql, {
    organizationId: job.organization_id,
    reelId,
    checkpointHours: checkpoint,
    hoursSincePost: hoursSincePosted(reel.postedAt, capturedAt),
    views: match.views,
    likes: match.likes,
    comments: match.comments,
    capturedAt,
  });
  const outcome = rateReel({
    creatorMedianViews: reel.creatorMedianViews,
    baselineReason: reel.creatorBaselineReason,
    snapshots: await observedPoints(sql, job.organization_id, reelId),
  });
  await recordReelRating(sql, {
    organizationId: job.organization_id,
    reelId,
    checkpointHours: checkpoint,
    outcome,
    creatorMedianViews: reel.creatorMedianViews,
  });
  return `snapshot:${checkpoint}h:views:${match.views ?? "unknown"}:tier:${outcome.tier ?? "not-rated"}`;
}
