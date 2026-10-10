import { useQueries } from "@tanstack/react-query";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { reviewsQueryOptions } from "@/lib/query/hooks";

/**
 * The stored review list for each brand, through the same query the brand overview reads. The home uses it only to count
 * decided reviews for the pipeline, so both screens agree on the Review stage.
 */
export function useBrandReviewLists(brandIds: string[]) {
  const { user, isPending } = useCurrentUserState();
  const userId = user?.id ?? null;
  const queries = useQueries({
    queries: brandIds.map((brandId) => ({
      ...reviewsQueryOptions(userId, brandId),
      enabled: !isPending && !!userId && !!brandId,
    })),
  });
  return queries.map((query, index) => ({ brandId: brandIds[index] ?? "", ...query }));
}
