import { createContext, useCallback, useContext, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { bootstrap, type Bootstrap } from "@/lib/meridian/api";
import { errorText } from "@/components/ui";
import { qk } from "@/lib/query/keys";
import { isForbiddenError } from "@/lib/navigation/model";

type WorkspaceState = {
  data: Bootstrap | null;
  loading: boolean;
  error: string | null;
  /** True when the bootstrap was refused for permission reasons. The layout shows the forbidden page instead of a retry. */
  forbidden: boolean;
  reload: () => Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user, isPending } = useCurrentUserState();
  const userId = user?.id ?? null;
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: qk.workspace(userId ?? "signed-out"),
    queryFn: bootstrap,
    enabled: !isPending && !!userId,
  });
  const reload = useCallback(async () => {
    if (!userId || isPending) return;
    try {
      await queryClient.fetchQuery({ queryKey: qk.workspace(userId), queryFn: bootstrap, staleTime: 0 });
    } catch {
      // Query state retains the normalized error for the existing context API.
    }
  }, [isPending, queryClient, userId]);
  const error = query.error ? errorText(query.error) : null;
  const forbidden = query.error ? isForbiddenError(query.error) : false;

  return (
    <WorkspaceContext.Provider value={{ data: query.data ?? null, loading: isPending || (!!userId && query.isPending), error, forbidden, reload }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceState {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Workspace is unavailable.");
  return value;
}
