// The sampling step of delivery (Video Engine Bible 6.14). After a request's videos are delivered, the format's sampling state is read, its
// threshold version applied, the rate for this delivery drawn, and each delivered video the draw samples is queued as a review item of
// kind 'sample'. Delivery does not wait for those items. The item ids and the draws are deterministic, so a retried delivery queues each
// item once and samples the same videos.

import { createHash } from "node:crypto";
import { isSampled, samplingRateOf, withThresholdVersion, type SamplingState } from "../review/sampling.ts";

export type SampleScope = { organizationId: string; formatKey: string };

/** One sampled video, ready to be queued for review. */
export type SampledVideoItem = {
  organizationId: string;
  itemId: string;
  requestId: string;
  videoId: string;
  formatKey: string;
  rate: number;
  reason: string;
  at: string;
};

/** The ports sampling needs. Production reads and writes the sampling state and the review items (jobs/sampling-store.ts). */
export type SamplingPorts = {
  state: (scope: SampleScope) => Promise<SamplingState>;
  save: (scope: SampleScope, state: SamplingState) => Promise<void>;
  queue: (item: SampledVideoItem) => Promise<void>;
};

/** A review item id that is the same on every retry: a sha256 of what it samples, written as a text key. */
export function sampleItemId(requestId: string, videoId: string): string {
  return `revsample_${createHash("sha256").update(`sample|${requestId}|${videoId}`).digest("hex").slice(0, 32)}`;
}

function percentOf(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/**
 * The sampling of one delivery. Returns the videos it sampled and the rate it used. The state is saved whether or not a video was sampled,
 * so the threshold version and any reset are recorded at the first delivery under them.
 */
export async function sampleDelivery(
  ports: SamplingPorts,
  input: { organizationId: string; requestId: string; formatKey: string; videoIds: readonly string[]; thresholdVersion: string; now: string },
): Promise<{ sampled: string[]; rate: number }> {
  const scope: SampleScope = { organizationId: input.organizationId, formatKey: input.formatKey };
  const state = withThresholdVersion(await ports.state(scope), input.thresholdVersion, input.now);
  const rate = samplingRateOf(state, input.now);
  const sampled: string[] = [];
  for (const videoId of input.videoIds) {
    if (!isSampled({ requestId: input.requestId, videoId }, rate)) continue;
    await ports.queue({
      organizationId: input.organizationId,
      itemId: sampleItemId(input.requestId, videoId),
      requestId: input.requestId,
      videoId,
      formatKey: input.formatKey,
      rate,
      reason: `Sampled after delivery: ${percentOf(rate)} of ${input.formatKey} videos are reviewed.`,
      at: input.now,
    });
    sampled.push(videoId);
  }
  await ports.save(scope, state);
  return { sampled, rate };
}
