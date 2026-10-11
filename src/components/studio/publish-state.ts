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
