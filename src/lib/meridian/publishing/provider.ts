export type PublishRequest = {
  organizationId: string;
  brandId: string;
  creativeId: string;
  platform: string;
};

export type PublishResult = {
  status: "NOT_CONNECTED";
  externalId: null;
  detail: string;
};

/** What the deployment reports about publishing. Publishing is chosen per channel, so no single status describes it. */
export const CHANNEL_PUBLISHING_DETAIL = "Publishing is set per channel. Regular posts use the Facebook Page, Instagram, YouTube or TikTok accounts you connect on Connected accounts. Paid ads use a Meta or TikTok key. Nothing is published until you choose a channel.";

export function publishingProviderStatus(): PublishResult {
  return {
    status: "NOT_CONNECTED",
    externalId: null,
    detail: "No live publishing API is implemented in this build, so no channel can be connected. The creative was not sent anywhere.",
  };
}

export function publishWithProvider(_request: PublishRequest): PublishResult {
  return publishingProviderStatus();
}

export function syncPublishingStatus(): PublishResult {
  return {
    status: "NOT_CONNECTED",
    externalId: null,
    detail: "No live publishing API is implemented in this build, so no campaign status was synced.",
  };
}
