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
