/** The part of a destination the publish rules read. It carries no account detail beyond the reason it is not connected. */
export type PublishStateChannel = { connected: boolean; reason?: string };

/**
 * Why Publish cannot be used, or null when it can. When no destination is connected, nothing can be sent, so Publish is off and
 * the reason says so. Each destination row shows its own reason.
 */
export function publishBlockReason(channels: readonly PublishStateChannel[], selectedCount: number): string | null {
  if (channels.length === 0) return "No destination is listed for this brand, so there is nowhere to publish.";
  if (!channels.some((channel) => channel.connected)) {
    return "No destination is connected, so nothing can be published. Each destination below says why it is not connected.";
  }
  if (selectedCount === 0) return "Choose at least one destination to publish to.";
  return null;
}

/** True when no destination is connected. The dialog then offers delivery by hand, and nothing is sent. */
export function deliverByHandOnly(channels: readonly PublishStateChannel[]): boolean {
  return channels.length > 0 && !channels.some((channel) => channel.connected);
}

/**
 * The destinations whose last receipt is uncertain: an earlier attempt may have posted, and nothing was sent again. Only these offer the
 * "I checked the platform" confirmation. A destination with any other receipt never does.
 */
export function uncertainDestinations(
  results: readonly { channelId: string; platform: string; status: string }[] | null | undefined,
): { channelId: string; platform: string }[] {
  return (results ?? []).filter((receipt) => receipt.status === "uncertain").map((receipt) => ({ channelId: receipt.channelId, platform: receipt.platform }));
}

/** The sentence of the confirmation checkbox. It names each platform that is uncertain, so the person knows where to look. */
export function confirmRetryLabel(platformNames: readonly string[]): string {
  const names = [...new Set(platformNames)];
  const where = names.length === 0 ? "the platform" : names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `I checked ${where}: the earlier post is not there. Send it again.`;
}
