export type AccountSnapshot = {
  provider: string;
  status: string;
  accountId: string;
  permissions: string[];
  pageId: string;
  destinationUrl: string;
};

export type ReadinessState = "READY" | "NOT_READY" | "EXTERNAL_CONNECTION_REQUIRED" | "HUMAN_REVIEW";

const LIVE = new Set(["meta", "tiktok", "google"]);

function connected(status: string): boolean {
  return status === "CONNECTED" || status === "HEALTHY";
}

/**
 * Readiness uses stored account rows, not environment variables.
 * A test publisher is never treated as a live ad account.
 */
export function assessPublishing(input: {
  accounts: AccountSnapshot[];
  provider: string;
  kind: "image" | "video";
  mime: string;
  width: number | null;
  height: number | null;
  byteSize: number;
  destinationUrl: string;
}): { state: ReadinessState; summary: string } {
  if (input.provider.startsWith("test:")) {
    return {
      state: "HUMAN_REVIEW",
      summary: `${input.provider} is an explicit test publisher. No ad account was checked, so this is not publishable to a live network.`,
    };
  }
  if (!LIVE.has(input.provider)) {
    return {
      state: "EXTERNAL_CONNECTION_REQUIRED",
      summary: `No publishing readiness adapter is configured for ${input.provider || "an empty provider"}.`,
    };
  }
  const account = input.accounts.find((item) => item.provider === input.provider);
  if (!account || !connected(account.status)) {
    return {
      state: "EXTERNAL_CONNECTION_REQUIRED",
      summary: `No connected ${input.provider} account is stored for this workspace.`,
    };
  }
  if (!account.accountId.trim()) {
    return { state: "NOT_READY", summary: `${input.provider} is connected but the account id is empty.` };
  }
  if (input.provider === "meta" && !account.pageId.trim()) {
    return { state: "NOT_READY", summary: "Meta needs a stored page id before an ad can be created." };
  }
  if (input.byteSize <= 0) {
    return { state: "NOT_READY", summary: "The creative has no stored media bytes." };
  }
  const imageOk = input.kind === "image" && input.mime.startsWith("image/") && (input.width ?? 0) >= 64 && (input.height ?? 0) >= 64;
  const videoOk = input.kind === "video" && input.mime.startsWith("video/") && (input.width ?? 0) >= 64 && (input.height ?? 0) >= 64;
  if (!imageOk && !videoOk) {
    return { state: "NOT_READY", summary: `Stored ${input.mime || "unknown"} ${input.width ?? 0}×${input.height ?? 0} is not a supported ${input.kind} for ${input.provider}.` };
  }
  const destination = input.destinationUrl.trim() || account.destinationUrl.trim();
  if (!destination.startsWith("https://")) {
    return { state: "NOT_READY", summary: `${input.provider} needs an https destination before the ad can be created.` };
  }
  if (account.permissions.length > 0 && !account.permissions.some((item) => /ads|write|manage/i.test(item))) {
    return { state: "NOT_READY", summary: `${input.provider} permissions do not include an ads write scope.` };
  }
  return {
    state: "READY",
    summary: `${input.provider} account ${account.accountId} is connected. ${input.kind} ${input.mime} ${input.width}×${input.height} and destination are present. This does not mean the ad was published.`,
  };
}
