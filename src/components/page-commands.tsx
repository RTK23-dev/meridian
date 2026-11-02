import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { PageCommandContext, type PageCommandRegistry } from "@/components/page-commands-context";

// The provider lives here. The hooks and the context are in page-commands-context.ts, so this file exports only the component
// (react-refresh) and the types that other screens name.
export type { PageCommand } from "@/components/page-commands-context";

export function PageCommandProvider({ children }: { children: ReactNode }) {
  const owners = useRef(new Map<symbol, () => ReturnType<PageCommandRegistry["readAll"]>>());
  const register = useCallback((owner: symbol, read: () => ReturnType<PageCommandRegistry["readAll"]>) => {
    owners.current.set(owner, read);
    return () => { owners.current.delete(owner); };
  }, []);
  const readAll = useCallback(() => [...owners.current.values()].flatMap((read) => read()), []);
  const value = useMemo(() => ({ register, readAll }), [register, readAll]);
  return <PageCommandContext.Provider value={value}>{children}</PageCommandContext.Provider>;
}
