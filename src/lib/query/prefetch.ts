import type { QueryClient } from "@tanstack/react-query";
import {
  accountsQueryOptions,
  alertsQueryOptions,
  assetsQueryOptions,
  brandQueryOptions,
  calibrationQueryOptions,
  factoryQueryOptions,
  integrationsQueryOptions,
  intelligenceQueryOptions,
  jobsQueryOptions,
  learningQueryOptions,
  libraryQueryOptions,
  machineQueryOptions,
  marketQueryOptions,
  notificationsQueryOptions,
  opportunitiesQueryOptions,
  providerSettingsQueryOptions,
  reviewsQueryOptions,
  studioQueryOptions,
  telemetryQueryOptions,
  usageQueryOptions,
} from "./hooks";
import { warmSpecs, type WarmSpec } from "./warm-targets";

export type PrefetchScope = {
  userId: string | null | undefined;
  organizationId: string | null | undefined;
};

/** Each warmer prefetches one query the target screen reads. */
type Warmer = (queryClient: QueryClient) => Promise<void>;

/**
 * Warms the cache for the screen a link points to, so the click renders from cache. Each entry is built by the same
 * option factory the screen's hook uses. Which queries a path warms is decided by warm-targets.ts.
 */
export function prefetchScreen(queryClient: QueryClient, scope: PrefetchScope, to: string): void {
  for (const warm of screenWarmers(scope, to)) void warm(queryClient);
}

export function screenWarmers({ userId, organizationId }: PrefetchScope, to: string): Warmer[] {
  if (!userId) return [];
  return warmSpecs(to, { signedIn: true, organizationId }).map((spec) => (queryClient: QueryClient) => prefetchSpec(queryClient, userId, spec));
}

function prefetchSpec(queryClient: QueryClient, userId: string, { query, id }: WarmSpec): Promise<void> {
  switch (query) {
    case "brand": return queryClient.prefetchQuery(brandQueryOptions(userId, id));
    case "machine": return queryClient.prefetchQuery(machineQueryOptions(userId, id));
    case "market": return queryClient.prefetchQuery(marketQueryOptions(userId, id));
    case "intelligence": return queryClient.prefetchQuery(intelligenceQueryOptions(userId, id));
    case "opportunities": return queryClient.prefetchQuery(opportunitiesQueryOptions(userId, id));
    case "reviews": return queryClient.prefetchQuery(reviewsQueryOptions(userId, id));
    case "studio": return queryClient.prefetchQuery(studioQueryOptions(userId, id));
    case "library": return queryClient.prefetchQuery(libraryQueryOptions(userId, id));
    case "learning": return queryClient.prefetchQuery(learningQueryOptions(userId, id));
    case "telemetry": return queryClient.prefetchQuery(telemetryQueryOptions(userId, id));
    case "calibration": return queryClient.prefetchQuery(calibrationQueryOptions(userId, id));
    case "assets": return queryClient.prefetchQuery(assetsQueryOptions(userId, id));
    case "accounts": return queryClient.prefetchQuery(accountsQueryOptions(userId, id));
    case "factory": return queryClient.prefetchQuery(factoryQueryOptions(userId, id));
    case "integrations": return queryClient.prefetchQuery(integrationsQueryOptions(userId, id));
    case "jobs": return queryClient.prefetchQuery(jobsQueryOptions(userId, id));
    case "usage": return queryClient.prefetchQuery(usageQueryOptions(userId, id));
    case "alerts": return queryClient.prefetchQuery(alertsQueryOptions(userId, id));
    case "notifications": return queryClient.prefetchQuery(notificationsQueryOptions(userId, id));
    case "providerSettings": return queryClient.prefetchQuery(providerSettingsQueryOptions(userId, id));
  }
}
