import { acceptPerformanceEvent, type PerformanceEvent } from "../performance/normalize.ts";

export type ProviderState = "SUPPORTED" | "CONNECTED" | "SYNCING" | "FAILED" | "NOT_CONNECTED";

export type AccountProvider = "meta" | "tiktok" | "google" | "ad_library";

export function accountProviderState(provider: AccountProvider, env: NodeJS.ProcessEnv = process.env): {
  provider: AccountProvider;
  status: ProviderState;
  detail: string;
} {
  const key = {
    meta: "META_ACCESS_TOKEN",
    tiktok: "TIKTOK_ACCESS_TOKEN",
    google: "GOOGLE_ADS_DEVELOPER_TOKEN",
    ad_library: "META_AD_LIBRARY_TOKEN",
  }[provider];
  if (!env[key]?.trim()) {
    return {
      provider,
      status: "NOT_CONNECTED",
      detail: `${provider} has an adapter and no credentials. No account was queried and no id was invented.`,
    };
  }
  return {
    provider,
    status: "SUPPORTED",
    detail: `${provider} credentials are present. This build does not call the live API until a request is made, and a failed request stores nothing.`,
  };
}

export type PublishOutcome =
  | { status: "NOT_CONNECTED"; externalId: null; mode: "live" }
  | { status: "TEST_PUBLISHED"; externalId: string; mode: "test" };

/** Live adapters never invent an external id. The test adapter is explicit and prefixed. */
export function publishThrough(input: {
  provider: AccountProvider | "test";
  creativeId: string;
  allowTestProvider?: boolean;
  env?: NodeJS.ProcessEnv;
}): PublishOutcome {
  if (input.provider === "test") {
    if (!input.allowTestProvider) throw new Error("The test publishing provider is not enabled.");
    return { status: "TEST_PUBLISHED", externalId: `test:${input.creativeId}`, mode: "test" };
  }
  const state = accountProviderState(input.provider, input.env);
  if (state.status !== "CONNECTED") return { status: "NOT_CONNECTED", externalId: null, mode: "live" };
  return { status: "NOT_CONNECTED", externalId: null, mode: "live" };
}

export function ingestPerformance(input: {
  provider: AccountProvider | "test";
  allowTestProvider?: boolean;
  events?: PerformanceEvent[];
  existing?: PerformanceEvent[];
  env?: NodeJS.ProcessEnv;
}): { status: "NOT_CONNECTED" | "STORED" | "REJECTED"; events: PerformanceEvent[]; detail: string } {
  if (input.provider !== "test") {
    const state = accountProviderState(input.provider, input.env);
    return { status: "NOT_CONNECTED", events: [], detail: state.detail };
  }
  if (!input.allowTestProvider) throw new Error("The test performance provider is not enabled.");
  const stored: PerformanceEvent[] = [];
  let prior = [...(input.existing ?? [])];
  for (const event of input.events ?? []) {
    const result = acceptPerformanceEvent(prior, event);
    if (result.status === "rejected" || result.status === "conflict") {
      return { status: "REJECTED", events: [], detail: result.status === "rejected" ? result.detail : result.detail };
    }
    if (result.status === "stored") {
      stored.push(event);
      prior = [...prior, event];
    }
  }
  return {
    status: "STORED",
    events: stored,
    detail: "Test provider only. These rows were supplied by the test, not by an ad account.",
  };
}

export function collectMarket(provider: "manual" | "public_page" | "ad_library" | "social", env: NodeJS.ProcessEnv = process.env): {
  status: "AVAILABLE" | "NOT_CONNECTED";
  detail: string;
} {
  if (provider === "manual") return { status: "AVAILABLE", detail: "A person can store an observation." };
  if (provider === "public_page") return { status: "AVAILABLE", detail: "One public URL can be fetched. The text is untrusted." };
  if (provider === "ad_library") return { status: "NOT_CONNECTED", detail: accountProviderState("ad_library", env).detail };
  return { status: "NOT_CONNECTED", detail: "No social listening account is connected. No posts were collected." };
}
