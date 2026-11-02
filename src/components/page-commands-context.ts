import { createContext, useContext, useEffect, useRef, useState } from "react";

/** An action a screen offers in the command palette. Register only actions the screen can run now, with its role checks applied. */
export type PageCommand = { id: string; label: string; run: () => void };

export type PageCommandRegistry = {
  register: (owner: symbol, read: () => PageCommand[]) => () => void;
  readAll: () => PageCommand[];
};

/** The registry the provider in page-commands.tsx supplies. Null outside a provider, so a screen registers nothing there. */
export const PageCommandContext = createContext<PageCommandRegistry | null>(null);

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

export function usePageCommandRegistry(): PageCommandRegistry | null {
  return useContext(PageCommandContext);
}
