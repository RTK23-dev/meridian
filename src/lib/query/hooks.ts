import { queryOptions, useMutation, useMutationState, useQueries, useQuery, useQueryClient, type MutationKey, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorText } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { getBrand } from "@/lib/meridian/api";
import { getIntelligence, getLearning, getMachine, getMarket, listBrandAssets, listLibrary, listOpportunities, listReviews, getTrace, resolveReview, dismissOpportunity } from "@/lib/meridian/machine";
import { getCalibration, listCalibrationVersions } from "@/lib/meridian/calibration/actions";
import { getFactoryBoard } from "@/lib/meridian/factory/actions";
import { getStudioBriefReview, getStudioSession, listHeldBudgetReservations } from "@/lib/meridian/studio/actions";
import { getDistributionChannels, getOrganicDistribution } from "@/lib/meridian/distribution/actions";
import { getPlatformAccountsAction } from "@/lib/meridian/accounts/actions";
import { getJevAccountIntelligenceFn, updateWhitespaceStatusFn, runAccountIntelligenceAnalysisFn } from "@/lib/meridian/jev/actions";
import {
  listPublishingQueueAction,
  scheduleMultiAccountPublishAction,
  cancelPublishJobAction,
  retryPublishJobAction,
} from "@/lib/meridian/publishing/orchestrator-actions";
import {
  getTelemetrySummaryAction,
  recordTelemetryAction,
  syncTelemetryPriorsAction,
} from "@/lib/meridian/learning/telemetry-actions";
import { getPipelineConfig } from "@/lib/meridian/factory/pipeline-actions";
import { getSystemStatus } from "@/lib/meridian/system";
import { acknowledgeStoredAlert, getAlerts } from "@/lib/meridian/alerts/actions";
import { getDecisionEngines, getProviderSettings } from "@/lib/meridian/settings/server-actions";
import { cancelJob, getJobDetail, getWorkerHealth, listJobs, listUsage, retryJob } from "@/lib/meridian/jobs/actions";
import { getNotificationPreferences } from "@/lib/meridian/observability/actions";
import { qk, userScopedQueryKey } from "./keys";
import { ACTIVE_POLL_MS, jobDetailRefetchInterval, jobsRefetchInterval } from "./polling";
import { markAlertAcknowledged, markOpportunitiesDismissed, markReviewResolved } from "./optimistic";

/** The user and whether the session has resolved. Queries stay disabled until both are known. */
function useSession() {
  const { user, isPending } = useCurrentUserState();
  return { userId: user?.id ?? null, ready: !isPending && !!user };
}

// ---------------------------------------------------------------------------
// Query option factories. Hooks and prefetching both use these, so a prefetched
// entry is exactly the entry the screen reads.
// ---------------------------------------------------------------------------

export const brandQueryOptions = (userId: string | null | undefined, brandId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.brand(brandId)),
  queryFn: () => getBrand({ data: { brandId } }),
});
export const machineQueryOptions = (userId: string | null | undefined, brandId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.machine(brandId)),
  queryFn: () => getMachine({ data: { brandId } }),
});
export const intelligenceQueryOptions = (userId: string | null | undefined, brandId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.intelligence(brandId)),
  queryFn: () => getIntelligence({ data: { brandId } }),
});
export const studioQueryOptions = (userId: string | null | undefined, brandId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.studio(brandId)),
  queryFn: () => getStudioSession({ data: { brandId } }),
});
export const briefReviewQueryOptions = (userId: string | null | undefined, brandId: string, briefId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.briefReview(brandId, briefId)),
  queryFn: () => getStudioBriefReview({ data: { brandId, briefId } }),
});
export const opportunitiesQueryOptions = (userId: string | null | undefined, brandId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.opportunities(brandId)),
  queryFn: () => listOpportunities({ data: { brandId } }),
});
export const marketQueryOptions = (userId: string | null | undefined, brandId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.market(brandId)),
  queryFn: () => getMarket({ data: { brandId } }),
});
export const reviewsQueryOptions = (userId: string | null | undefined, brandId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.reviews(brandId)),
  queryFn: () => listReviews({ data: { brandId } }),
});
export const libraryQueryOptions = (userId: string | null | undefined, brandId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.library(brandId)),
  queryFn: () => listLibrary({ data: { brandId } }),
});
export const assetsQueryOptions = (userId: string | null | undefined, brandId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.assets(brandId)),
  queryFn: () => listBrandAssets({ data: { brandId } }),
});
export const learningQueryOptions = (userId: string | null | undefined, brandId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.learning(brandId)),
  queryFn: () => getLearning({ data: { brandId } }),
});
export const factoryQueryOptions = (userId: string | null | undefined, brandId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.factory(brandId)),
  queryFn: () => getFactoryBoard({ data: { brandId } }),
});
export const calibrationQueryOptions = (userId: string | null | undefined, brandId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.calibration(brandId)),
  queryFn: () => getCalibration({ data: { brandId } }),
});
export const integrationsQueryOptions = (userId: string | null | undefined, organizationId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.integrations(organizationId)),
  queryFn: () => getSystemStatus({ data: { organizationId } }),
});
export const channelsQueryOptions = (userId: string | null | undefined, brandId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.channels(brandId)),
  queryFn: () => getDistributionChannels({ data: { brandId } }),
});
export const organicQueryOptions = (userId: string | null | undefined, brandId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.organic(brandId)),
  queryFn: () => getOrganicDistribution({ data: { brandId } }),
});
export const accountsQueryOptions = (userId: string | null | undefined, brandId: string, platform?: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.accounts(brandId, platform)),
  queryFn: () => getPlatformAccountsAction({ data: { brandId, platform } }),
});
export const accountIntelligenceQueryOptions = (userId: string | null | undefined, brandId: string, platform: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.accountIntelligence(brandId, platform)),
  queryFn: () => getJevAccountIntelligenceFn({ data: { brandId, platform } }),
});
export const publishingQueueQueryOptions = (userId: string | null | undefined, brandId: string, status?: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.publishingQueue(brandId, status)),
  queryFn: () => listPublishingQueueAction({ data: { brandId, status } }),
});
export const telemetryQueryOptions = (userId: string | null | undefined, brandId: string, platform?: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.telemetry(brandId, platform)),
  queryFn: () => getTelemetrySummaryAction({ data: { brandId, platform } }),
});
export const pipelineConfigQueryOptions = (userId: string | null | undefined, brandId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.pipelineConfig(brandId)),
  queryFn: () => getPipelineConfig({ data: { brandId } }),
});
export const heldReservationsQueryOptions = (userId: string | null | undefined, brandId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.heldReservations(brandId)),
  queryFn: () => listHeldBudgetReservations({ data: { brandId } }),
});
export const alertsQueryOptions = (userId: string | null | undefined, organizationId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.alerts(organizationId)),
  queryFn: () => getAlerts({ data: { organizationId } }),
});
export const providerSettingsQueryOptions = (userId: string | null | undefined, organizationId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.providerSettings(organizationId)),
  queryFn: () => getProviderSettings({ data: { organizationId } }),
});
export const decisionEnginesQueryOptions = (userId: string | null | undefined, organizationId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.decisionEngines(organizationId)),
  queryFn: () => getDecisionEngines({ data: { organizationId } }),
});
/** Filters for the jobs list. The default is the first, unfiltered page, which is what route prefetch loads. */
export type JobQueryFilters = { status: string; type: string; brandId: string; page: number };
export const EMPTY_JOB_QUERY: JobQueryFilters = { status: "", type: "", brandId: "", page: 0 };
export const jobsQueryOptions = (userId: string | null | undefined, organizationId: string, filters: JobQueryFilters = EMPTY_JOB_QUERY) => queryOptions({
  queryKey: userScopedQueryKey(userId, [...qk.jobs(organizationId), filters]),
  queryFn: () => listJobs({ data: { organizationId, ...filters } }),
});
export const jobDetailQueryOptions = (userId: string | null | undefined, organizationId: string, jobId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, [...qk.jobDetail(organizationId), jobId]),
  queryFn: () => getJobDetail({ data: { organizationId, jobId } }),
});
export const workerHealthQueryOptions = (userId: string | null | undefined, organizationId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.workerHealth(organizationId)),
  queryFn: () => getWorkerHealth({ data: { organizationId } }),
});
export const calibrationVersionsQueryOptions = (userId: string | null | undefined, brandId: string, page = 0) => queryOptions({
  queryKey: userScopedQueryKey(userId, [...qk.calibrationVersions(brandId), page]),
  queryFn: () => listCalibrationVersions({ data: { brandId, page } }),
});
export const usageQueryOptions = (userId: string | null | undefined, organizationId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.usage(organizationId)),
  queryFn: () => listUsage({ data: { organizationId } }),
});
export const notificationsQueryOptions = (userId: string | null | undefined, organizationId: string) => queryOptions({
  queryKey: userScopedQueryKey(userId, qk.notifications(organizationId)),
  queryFn: () => getNotificationPreferences({ data: { organizationId } }),
});

// ---------------------------------------------------------------------------
// Query hooks. Each returns the cached value at once on revisit (staleTime from the client).
// ---------------------------------------------------------------------------

export const useBrandQuery = (brandId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...brandQueryOptions(userId, brandId), enabled: ready && enabled && !!brandId });
};

export const useMachineQuery = (brandId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...machineQueryOptions(userId, brandId), enabled: ready && enabled && !!brandId });
};

export function useMachinesQuery(brandIds: string[]) {
  const { userId, ready } = useSession();
  const queries = useQueries({
    queries: brandIds.map((brandId) => ({
      ...machineQueryOptions(userId, brandId),
      enabled: ready && !!brandId,
    })),
  });
  return queries.map((query, index) => ({ brandId: brandIds[index], ...query }));
}

export const useIntelligenceQuery = (brandId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...intelligenceQueryOptions(userId, brandId), enabled: ready && enabled && !!brandId });
};

export const useStudioQuery = (brandId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({
    ...studioQueryOptions(userId, brandId),
    enabled: ready && enabled && !!brandId,
    // A variant that is queued, running or submitted to the provider is polled until it settles.
    refetchInterval: (query) => query.state.data?.variants.some((variant) => variant.mediaStatus === "queued" || variant.mediaStatus === "running" || variant.mediaStatus === "submitted") ? ACTIVE_POLL_MS : false,
  });
};

export const useBriefReviewQuery = (brandId: string, briefId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...briefReviewQueryOptions(userId, brandId, briefId), enabled: ready && enabled && !!brandId && !!briefId });
};

export const useOpportunitiesQuery = (brandId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...opportunitiesQueryOptions(userId, brandId), enabled: ready && enabled && !!brandId });
};

export const useMarketQuery = (brandId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({
    ...marketQueryOptions(userId, brandId),
    enabled: ready && enabled && !!brandId,
    refetchInterval: (query) => query.state.data?.researchRuns.some((run) => run.status === "queued" || run.status === "running") ? ACTIVE_POLL_MS : false,
  });
};

export const useReviewsQuery = (brandId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...reviewsQueryOptions(userId, brandId), enabled: ready && enabled && !!brandId });
};

export const useLibraryQuery = (brandId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...libraryQueryOptions(userId, brandId), enabled: ready && enabled && !!brandId });
};

export const useTraceQuery = (brandId: string, creativeId: string | null, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({
    queryKey: userScopedQueryKey(userId, qk.trace(brandId, creativeId ?? "")),
    queryFn: () => getTrace({ data: { brandId, creativeId: creativeId! } }),
    enabled: ready && enabled && !!brandId && !!creativeId,
  });
};

export const useAssetsQuery = (brandId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...assetsQueryOptions(userId, brandId), enabled: ready && enabled && !!brandId });
};

export const useLearningQuery = (brandId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...learningQueryOptions(userId, brandId), enabled: ready && enabled && !!brandId });
};

export const useFactoryQuery = (brandId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({
    ...factoryQueryOptions(userId, brandId),
    enabled: ready && enabled && !!brandId,
    refetchInterval: (query) => query.state.data?.runs.some((run) => run.status === "queued" || run.status === "running") ? ACTIVE_POLL_MS : false,
  });
};

export const useCalibrationQuery = (brandId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...calibrationQueryOptions(userId, brandId), enabled: ready && enabled && !!brandId });
};

export const useIntegrationsQuery = (organizationId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...integrationsQueryOptions(userId, organizationId), enabled: ready && enabled && !!organizationId });
};

export const useDistributionChannelsQuery = (brandId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...channelsQueryOptions(userId, brandId), enabled: ready && enabled && !!brandId });
};

export const useOrganicDistributionQuery = (brandId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...organicQueryOptions(userId, brandId), enabled: ready && enabled && !!brandId });
};

export const usePlatformAccountsQuery = (brandId: string, platform?: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...accountsQueryOptions(userId, brandId, platform), enabled: ready && enabled && !!brandId });
};

export const useAccountIntelligenceQuery = (brandId: string, platform = "instagram", enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...accountIntelligenceQueryOptions(userId, brandId, platform), enabled: ready && enabled && !!brandId });
};

export const usePublishingQueueQuery = (brandId: string, status?: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({
    ...publishingQueueQueryOptions(userId, brandId, status),
    enabled: ready && enabled && !!brandId,
    refetchInterval: (query) => {
      const data = query.state.data as { queue?: Array<{ status: string }> } | undefined;
      return data?.queue?.some((item) => item.status === "queued" || item.status === "processing") ? ACTIVE_POLL_MS : false;
    },
  });
};

export const useTelemetryQuery = (brandId: string, platform?: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...telemetryQueryOptions(userId, brandId, platform), enabled: ready && enabled && !!brandId });
};

export const usePipelineConfigQuery = (brandId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...pipelineConfigQueryOptions(userId, brandId), enabled: ready && enabled && !!brandId });
};

export const useHeldReservationsQuery = (brandId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...heldReservationsQueryOptions(userId, brandId), enabled: ready && enabled && !!brandId });
};

export const useAlertsQuery = (organizationId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...alertsQueryOptions(userId, organizationId), enabled: ready && enabled && !!organizationId });
};

export const useProviderSettingsQuery = (organizationId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...providerSettingsQueryOptions(userId, organizationId), enabled: ready && enabled && !!organizationId });
};

export const useDecisionEnginesQuery = (organizationId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...decisionEnginesQueryOptions(userId, organizationId), enabled: ready && enabled && !!organizationId });
};

/** The jobs list polls only while a job is queued, retrying, or running. Otherwise it waits for focus or navigation. */
export const useJobsQuery = (organizationId: string, enabled = true, filters: JobQueryFilters = EMPTY_JOB_QUERY) => {
  const { userId, ready } = useSession();
  return useQuery({
    ...jobsQueryOptions(userId, organizationId, filters),
    enabled: ready && enabled && !!organizationId,
    refetchInterval: (query) => jobsRefetchInterval(query.state.data),
  });
};

/** Worker and scheduler heartbeats with queue counts. It polls only while `poll` is set, which the jobs screen sets while a job is active. */
export const useWorkerHealthQuery = (organizationId: string, enabled = true, poll = false) => {
  const { userId, ready } = useSession();
  return useQuery({
    ...workerHealthQueryOptions(userId, organizationId),
    enabled: ready && enabled && !!organizationId,
    refetchInterval: poll ? ACTIVE_POLL_MS : false,
  });
};

/** One job for the detail drawer. It polls while that job is queued, retrying, or running. */
export const useJobDetailQuery = (organizationId: string, jobId: string | null) => {
  const { userId, ready } = useSession();
  return useQuery({
    ...jobDetailQueryOptions(userId, organizationId, jobId ?? ""),
    enabled: ready && !!organizationId && !!jobId,
    refetchInterval: (query) => jobDetailRefetchInterval(query.state.data),
  });
};

export const useCalibrationVersionsQuery = (brandId: string, page = 0, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...calibrationVersionsQueryOptions(userId, brandId, page), enabled: ready && enabled && !!brandId });
};

export const useUsageQuery = (organizationId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...usageQueryOptions(userId, organizationId), enabled: ready && enabled && !!organizationId });
};

export const useNotificationPreferencesQuery = (organizationId: string, enabled = true) => {
  const { userId, ready } = useSession();
  return useQuery({ ...notificationsQueryOptions(userId, organizationId), enabled: ready && enabled && !!organizationId });
};

// ---------------------------------------------------------------------------
// Mutations. Each mutation invalidates only the keys it changes, and toasts its outcome.
// ---------------------------------------------------------------------------

type ScopedMutationOptions<TVars, TData> = {
  /** Identifies the action. Pending state is read back with usePendingVariables(mutationKey). */
  mutationKey: MutationKey;
  mutationFn: (vars: TVars) => Promise<TData>;
  /** Unscoped keys to invalidate after success. The user scope is applied here. */
  invalidate?: (vars: TVars, data: TData) => readonly QueryKey[];
  /** Toast text shown after success. */
  success?: string | ((vars: TVars, data: TData) => string);
  /** Runs after invalidation, for state the query keys do not cover (for example the workspace list). */
  onSuccess?: (data: TData, vars: TVars) => void | Promise<void>;
};

/**
 * One action on a screen. It has its own pending state, so a running action does not disable unrelated controls.
 * Success invalidates only the keys the caller names and shows a toast. Failure shows an error toast; screens keep
 * their inline error for decisions.
 */
export function useScopedMutation<TVars, TData = unknown>(options: ScopedMutationOptions<TVars, TData>) {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  return useMutation<TData, Error, TVars>({
    mutationKey: options.mutationKey,
    mutationFn: options.mutationFn,
    onSuccess: async (data, vars) => {
      const keys = options.invalidate?.(vars, data) ?? [];
      await Promise.all(keys.map((key) => queryClient.invalidateQueries({ queryKey: userScopedQueryKey(userId, key) })));
      await options.onSuccess?.(data, vars);
      const message = typeof options.success === "function" ? options.success(vars, data) : options.success;
      if (message) toast.success(message);
    },
    onError: (error) => {
      toast.error(errorText(error));
    },
  });
}

/** The variables of every in-flight call to the action with this key, so a list can mark only its own rows as busy. */
export function usePendingVariables<TVars>(mutationKey: MutationKey): TVars[] {
  return useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (mutation) => mutation.state.variables as TVars,
  });
}

type ReviewsData = Awaited<ReturnType<typeof listReviews>>;
type OpportunitiesData = Awaited<ReturnType<typeof listOpportunities>>;
type AlertsData = Awaited<ReturnType<typeof getAlerts>>;

/**
 * Approve or reject a review. The row leaves the open list at once and returns if the server refuses.
 * The keys refresh on settle, so the cache matches the server after both success and failure.
 */
export function useResolveReview(brandId: string) {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  const key = userScopedQueryKey(userId, qk.reviews(brandId));
  return useMutation({
    mutationKey: ["mutation", "review.resolve", brandId],
    mutationFn: (vars: { reviewId: string; action: "approve" | "reject"; reasonCode: string; note: string }) =>
      resolveReview({ data: { brandId, ...vars } }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ReviewsData>(key);
      queryClient.setQueryData<ReviewsData>(key, (current) => markReviewResolved(current, vars.reviewId, vars.action));
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      toast.error(errorText(error));
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.action === "approve" ? "Review approved." : "Review rejected.");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: userScopedQueryKey(userId, qk.machine(brandId)) });
      void queryClient.invalidateQueries({ queryKey: userScopedQueryKey(userId, qk.opportunities(brandId)) });
      void queryClient.invalidateQueries({ queryKey: userScopedQueryKey(userId, qk.studio(brandId)) });
    },
  });
}

/** Dismiss one or more opportunities. Rows show as dismissed at once and roll back if the server refuses. */
export function useDismissOpportunities(brandId: string) {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  const key = userScopedQueryKey(userId, qk.opportunities(brandId));
  return useMutation({
    mutationKey: ["mutation", "opportunity.dismiss", brandId],
    mutationFn: async (opportunityIds: string[]) => {
      for (const opportunityId of opportunityIds) {
        await dismissOpportunity({ data: { brandId, opportunityId } });
      }
    },
    onMutate: async (opportunityIds) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<OpportunitiesData>(key);
      queryClient.setQueryData<OpportunitiesData>(key, (current) => markOpportunitiesDismissed(current, opportunityIds));
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      toast.error(errorText(error));
    },
    onSuccess: (_data, opportunityIds) => {
      toast.success(opportunityIds.length === 1 ? "Opportunity dismissed." : `${opportunityIds.length} opportunities dismissed.`);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: userScopedQueryKey(userId, qk.machine(brandId)) });
      void queryClient.invalidateQueries({ queryKey: userScopedQueryKey(userId, qk.studio(brandId)) });
    },
  });
}

/** Acknowledge a stored alert. The alert shows as acknowledged at once and rolls back if the server refuses. */
export function useAcknowledgeAlert(organizationId: string) {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  const key = userScopedQueryKey(userId, qk.alerts(organizationId));
  return useMutation({
    mutationKey: ["mutation", "alert.acknowledge", organizationId],
    mutationFn: (alertId: string) => acknowledgeStoredAlert({ data: { organizationId, alertId } }),
    onMutate: async (alertId) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<AlertsData>(key);
      queryClient.setQueryData<AlertsData>(key, (current) => markAlertAcknowledged(current, alertId));
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      toast.error(errorText(error));
    },
    onSuccess: () => {
      toast.success("Acknowledged. Thresholds and providers were not changed.");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

export type JobAction = "retry" | "cancel";
export const jobActionKey = (action: JobAction, organizationId: string) => ["mutation", `jobs.${action}`, organizationId] as const;

/**
 * Retry a dead job or cancel a queued one. This hook shows no toast: the server's refusal is the error, and the jobs screen
 * shows it as a message next to the job. The jobs list, the job detail and the health cards refresh once the call settles.
 */
export function useJobActionMutation(organizationId: string, action: JobAction) {
  const queryClient = useQueryClient();
  const { userId } = useSession();
  return useMutation({
    mutationKey: jobActionKey(action, organizationId),
    mutationFn: async (jobId: string): Promise<{ status: "queued" | "cancel_requested"; jobId: string }> => action === "retry"
      ? retryJob({ data: { organizationId, jobId } })
      : cancelJob({ data: { organizationId, jobId } }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: userScopedQueryKey(userId, qk.jobs(organizationId)) });
      void queryClient.invalidateQueries({ queryKey: userScopedQueryKey(userId, qk.jobDetail(organizationId)) });
      void queryClient.invalidateQueries({ queryKey: userScopedQueryKey(userId, qk.workerHealth(organizationId)) });
    },
  });
}

export const useUpdateWhitespaceStatus = (brandId: string) => useScopedMutation({
  mutationKey: ["mutation", "whitespace.status", brandId],
  mutationFn: (vars: { opportunityId: string; status: "proposed" | "accepted" | "rejected" | "explored" }) =>
    updateWhitespaceStatusFn({ data: { brandId, ...vars } }),
  invalidate: () => [qk.accountIntelligence(brandId)],
});

export const useRunAccountIntelligence = (brandId: string) => useScopedMutation({
  mutationKey: ["mutation", "account-intelligence.run", brandId],
  mutationFn: (vars: { platform: string; accountHandle: string; items: any[] }) =>
    runAccountIntelligenceAnalysisFn({ data: { brandId, ...vars } }),
  invalidate: () => [qk.accountIntelligence(brandId)],
});

export const useScheduleMultiAccountPublish = (brandId: string) => useScopedMutation({
  mutationKey: ["mutation", "publish.schedule", brandId],
  mutationFn: (vars: { creativeId: string; targetAccountIds: string[]; scheduledTime?: string; targetType?: "organic" | "paid_campaign" }) =>
    scheduleMultiAccountPublishAction({ data: { brandId, ...vars } }),
  invalidate: () => [qk.publishingQueue(brandId)],
  success: "Publish scheduled. The queue shows its progress.",
});

export const useCancelPublishJob = (brandId: string) => useScopedMutation({
  mutationKey: ["mutation", "publish.cancel", brandId],
  mutationFn: (vars: { queueId: string }) => cancelPublishJobAction({ data: { brandId, ...vars } }),
  invalidate: () => [qk.publishingQueue(brandId)],
  success: "Publish job cancelled.",
});

export const useRetryPublishJob = (brandId: string) => useScopedMutation({
  mutationKey: ["mutation", "publish.retry", brandId],
  mutationFn: (vars: { queueId: string }) => retryPublishJobAction({ data: { brandId, ...vars } }),
  invalidate: () => [qk.publishingQueue(brandId)],
  success: "Publish job queued for retry.",
});

export const useRecordTelemetry = (brandId: string) => useScopedMutation({
  mutationKey: ["mutation", "telemetry.record", brandId],
  mutationFn: (vars: {
    platform: string;
    sourceType?: "organic" | "paid" | "hybrid";
    creativeId?: string;
    variantId?: string;
    views?: number;
    impressions?: number;
    reach?: number;
    clicks?: number;
    engagements?: number;
    shares?: number;
    saves?: number;
    conversions?: number;
    hookType?: string;
    angle?: string;
    hookRetention3s?: number;
    completionRate?: number;
  }) => recordTelemetryAction({ data: { brandId, ...vars } }),
  invalidate: () => [qk.telemetry(brandId), qk.learning(brandId)],
});

export const useSyncTelemetry = (brandId: string) => useScopedMutation({
  mutationKey: ["mutation", "telemetry.sync", brandId],
  mutationFn: () => syncTelemetryPriorsAction({ data: { brandId } }),
  invalidate: () => [qk.telemetry(brandId), qk.learning(brandId), qk.accountIntelligence(brandId)],
});
