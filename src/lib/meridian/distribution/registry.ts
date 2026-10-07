import type { DistributionChannel, PlatformId, OrganicPublishRequest, OrganicPublishReceipt } from "./types.ts";
import { InstagramReelsChannel } from "./instagram.ts";
import { FacebookPagesChannel } from "./facebook.ts";
import { YouTubeShortsChannel } from "./youtube.ts";

const builtInChannels = new Map<string, DistributionChannel>([
  ["instagram-reels", new InstagramReelsChannel()],
  ["facebook-pages", new FacebookPagesChannel()],
  ["youtube-shorts", new YouTubeShortsChannel()],
]);

export function getDistributionChannel(channelId: string): DistributionChannel | undefined {
  return builtInChannels.get(channelId);
}

export function registerDistributionChannel(channel: DistributionChannel): void {
  builtInChannels.set(channel.id, channel);
}

export function listDistributionChannels(): readonly DistributionChannel[] {
  return [...builtInChannels.values()];
}

export type SelectivePublishOptions = {
  selectedChannelIds: string[];
  request: OrganicPublishRequest;
};

/**
 * Publishes content exclusively to the channels selected by the user.
 * No channel is mandatory: only specified channel IDs receive publication commands.
 */
export async function publishToSelectedChannels(
  options: SelectivePublishOptions,
): Promise<{ channelId: string; receipt: OrganicPublishReceipt }[]> {
  const results: { channelId: string; receipt: OrganicPublishReceipt }[] = [];

  for (const channelId of options.selectedChannelIds) {
    const channel = getDistributionChannel(channelId);
    if (!channel) {
      results.push({
        channelId,
        receipt: {
          externalId: "",
          platform: "instagram" as PlatformId,
          status: "failed",
          error: `Channel "${channelId}" is not registered in the system.`,
        },
      });
      continue;
    }

    const receipt = await channel.publish(options.request);
    results.push({ channelId, receipt });
  }

  return results;
}
