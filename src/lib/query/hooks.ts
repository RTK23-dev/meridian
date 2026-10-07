import { useQueries, useQuery } from "@tanstack/react-query";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { getBrand } from "@/lib/meridian/api";
import { getIntelligence, getLearning, getMachine, getMarket, listBrandAssets, listLibrary, listOpportunities, listReviews, getTrace } from "@/lib/meridian/machine";
import { getCalibration } from "@/lib/meridian/calibration/actions";
import { getFactoryBoard } from "@/lib/meridian/factory/actions";
import { getStudioSession } from "@/lib/meridian/studio/actions";
import { getSystemStatus } from "@/lib/meridian/system";
import { qk, userScopedQueryKey } from "./keys";

function useUserScopedKey(key: readonly unknown[]) {
  const { user, isPending } = useCurrentUserState();
  return { queryKey: userScopedQueryKey(user?.id, key), enabled: !isPending && !!user };
}

export const useBrandQuery = (brandId: string, enabled = true) => {
  const scope = useUserScopedKey(qk.brand(brandId));
  return useQuery({ ...scope, queryFn: () => getBrand({ data: { brandId } }), enabled: scope.enabled && enabled && !!brandId });
};
export const useMachineQuery = (brandId: string, enabled = true) => {
  const scope = useUserScopedKey(qk.machine(brandId));
  return useQuery({ ...scope, queryFn: () => getMachine({ data: { brandId } }), enabled: scope.enabled && enabled && !!brandId });
};
export function useMachinesQuery(brandIds: string[]) {
  const { user, isPending } = useCurrentUserState();
  const queries = useQueries({
    queries: brandIds.map((brandId) => ({
      queryKey: userScopedQueryKey(user?.id, qk.machine(brandId)),
      queryFn: () => getMachine({ data: { brandId } }),
      enabled: !isPending && !!user && !!brandId,
    })),
  });
  return queries.map((query, index) => ({ brandId: brandIds[index], ...query }));
}
export const useIntelligenceQuery = (brandId: string, enabled = true) => {
  const scope = useUserScopedKey(qk.intelligence(brandId));
  return useQuery({ ...scope, queryFn: () => getIntelligence({ data: { brandId } }), enabled: scope.enabled && enabled && !!brandId });
};
export const useStudioQuery = (brandId: string, enabled = true) => {
  const scope = useUserScopedKey(qk.studio(brandId));
  return useQuery({
    ...scope, queryFn: () => getStudioSession({ data: { brandId } }), enabled: scope.enabled && enabled && !!brandId,
    refetchInterval: (query) => query.state.data?.variants.some((variant) => variant.mediaStatus === "queued" || variant.mediaStatus === "running") ? 5_000 : false,
  });
};
export const useOpportunitiesQuery = (brandId: string, enabled = true) => {
  const scope = useUserScopedKey(qk.opportunities(brandId));
  return useQuery({ ...scope, queryFn: () => listOpportunities({ data: { brandId } }), enabled: scope.enabled && enabled && !!brandId });
};
export const useMarketQuery = (brandId: string, enabled = true) => {
  const scope = useUserScopedKey(qk.market(brandId));
  return useQuery({
    ...scope, queryFn: () => getMarket({ data: { brandId } }), enabled: scope.enabled && enabled && !!brandId,
    refetchInterval: (query) => query.state.data?.researchRuns.some((run) => run.status === "queued" || run.status === "running") ? 5_000 : false,
  });
};
export const useReviewsQuery = (brandId: string, enabled = true) => {
  const scope = useUserScopedKey(qk.reviews(brandId));
  return useQuery({ ...scope, queryFn: () => listReviews({ data: { brandId } }), enabled: scope.enabled && enabled && !!brandId });
};
export const useLibraryQuery = (brandId: string, enabled = true) => {
  const scope = useUserScopedKey(qk.library(brandId));
  return useQuery({ ...scope, queryFn: () => listLibrary({ data: { brandId } }), enabled: scope.enabled && enabled && !!brandId });
};
export const useTraceQuery = (brandId: string, creativeId: string | null, enabled = true) => {
  const scope = useUserScopedKey(qk.trace(brandId, creativeId ?? ""));
  return useQuery({ ...scope, queryFn: () => getTrace({ data: { brandId, creativeId: creativeId! } }), enabled: scope.enabled && enabled && !!brandId && !!creativeId });
};
export const useAssetsQuery = (brandId: string, enabled = true) => {
  const scope = useUserScopedKey(qk.assets(brandId));
  return useQuery({ ...scope, queryFn: () => listBrandAssets({ data: { brandId } }), enabled: scope.enabled && enabled && !!brandId });
};
export const useLearningQuery = (brandId: string, enabled = true) => {
  const scope = useUserScopedKey(qk.learning(brandId));
  return useQuery({ ...scope, queryFn: () => getLearning({ data: { brandId } }), enabled: scope.enabled && enabled && !!brandId });
};
export const useFactoryQuery = (brandId: string, enabled = true) => {
  const scope = useUserScopedKey(qk.factory(brandId));
  return useQuery({
    ...scope,
    queryFn: () => getFactoryBoard({ data: { brandId } }),
    enabled: scope.enabled && enabled && !!brandId,
    refetchInterval: (query) => query.state.data?.runs.some((run) => run.status === "queued" || run.status === "running") ? 5_000 : false,
  });
};
export const useCalibrationQuery = (brandId: string, enabled = true) => {
  const scope = useUserScopedKey(qk.calibration(brandId));
  return useQuery({ ...scope, queryFn: () => getCalibration({ data: { brandId } }), enabled: scope.enabled && enabled && !!brandId });
};
export const useIntegrationsQuery = (organizationId: string, enabled = true) => {
  const scope = useUserScopedKey(qk.integrations(organizationId));
  return useQuery({ ...scope, queryFn: () => getSystemStatus({ data: { organizationId } }), enabled: scope.enabled && enabled && !!organizationId });
};
