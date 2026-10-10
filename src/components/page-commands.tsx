import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** An action a screen offers in the command palette. Register only actions the screen can run now, with its role checks applied. */
export type PageCommand = { id: string; label: string; run: () => void };

type Registry = {
  register: (owner: symbol, read: () => PageCommand[]) => () => void;
  readAll: () => PageCommand[];
};

const PageCommandContext = createContext<Registry | null>(null);

export function PageCommandProvider({ children }: { children: ReactNode }) {
  const owners = useRef(new Map<symbol, () => PageCommand[]>());
  const register = useCallback((owner: symbol, read: () => PageCommand[]) => {
    owners.current.set(owner, read);
    return () => { owners.current.delete(owner); };
  }, []);
  const readAll = useCallback(() => [...owners.current.values()].flatMap((read) => read()), []);
  const value = useMemo(() => ({ register, readAll }), [register, readAll]);
  return <PageCommandContext.Provider value={value}>{children}</PageCommandContext.Provider>;
}

/**
 * Registers a screen's palette actions for as long as the screen is mounted. The latest list is read when the palette
 * opens, so the actions can close over current data without re-registering on every render.
 */
export function usePageCommands(commands: PageCommand[]) {
  const registry = useContext(PageCommandContext);
  const latest = useRef(commands);
  const [owner] = useState(() => Symbol("page-commands"));
  useEffect(() => {
    latest.current = commands;
  });
  useEffect(() => registry?.register(owner, () => latest.current), [registry, owner]);
}

export function usePageCommandRegistry(): Registry | null {
  return useContext(PageCommandContext);
}
