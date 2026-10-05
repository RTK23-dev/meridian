import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { bootstrap, type Bootstrap } from "@/lib/meridian/api";
import { errorText } from "@/components/ui";

type WorkspaceState = {
  data: Bootstrap | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user, isPending } = useCurrentUserState();
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const userId = user?.id ?? null;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await bootstrap();
      setData(next);
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isPending || !userId) return;
    void reload();
  }, [isPending, userId, reload]);

  return (
    <WorkspaceContext.Provider value={{ data, loading, error, reload }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceState {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Workspace is unavailable.");
  return value;
}
