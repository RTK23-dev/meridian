import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "light" | "dark" | "system";
const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void }>({ theme: "system", setTheme: () => undefined });
const STORAGE_KEY = "meridian-theme";

function systemPrefersDark() { return window.matchMedia("(prefers-color-scheme: dark)").matches; }
function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.setAttribute("content", dark ? "dark light" : "light dark");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark" || stored === "system") setThemeState(stored);
    } catch { /* Storage can be disabled; system preference remains the fallback. */ }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    applyTheme(theme);
    if (theme === "system") {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const update = () => applyTheme("system");
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
  }, [ready, theme]);
  const setTheme = useCallback((next: Theme) => {
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Keep the current in-memory selection. */ }
    setThemeState(next);
  }, []);
  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() { return useContext(ThemeContext); }

export const themeBootstrap = `(()=>{try{const t=localStorage.getItem("${STORAGE_KEY}")||"system";const d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light"}catch{}})();`;
