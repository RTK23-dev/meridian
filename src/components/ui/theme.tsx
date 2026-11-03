import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ACCENT_KEY, ACCENT_PRESETS, DEFAULT_ACCENT, applyAccent, presetFor, readAccentChoice, writeAccentChoice, type AccentTheme } from "./accent";

export type Theme = "light" | "dark" | "system";
// The design follows the system setting until the reader makes a choice with the Dark or Light control, as the walkthrough does.
const DEFAULT_THEME: Theme = "system";
type ThemeValue = { theme: Theme; setTheme: (theme: Theme) => void; accent: string; setAccent: (id: string) => void };
const ThemeContext = createContext<ThemeValue>({ theme: DEFAULT_THEME, setTheme: () => undefined, accent: DEFAULT_ACCENT, setAccent: () => undefined });
const STORAGE_KEY = "meridian-theme";

function systemPrefersDark() { return window.matchMedia("(prefers-color-scheme: dark)").matches; }
function resolvedTheme(theme: Theme): AccentTheme {
  return theme === "dark" || (theme === "system" && systemPrefersDark()) ? "dark" : "light";
}
function applyTheme(theme: Theme) {
  const dark = resolvedTheme(theme) === "dark";
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.setAttribute("content", dark ? "dark light" : "light dark");
}
function paintAccent(id: string, theme: Theme) {
  applyAccent(document.documentElement, presetFor(id), resolvedTheme(theme));
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [accent, setAccentState] = useState<string>(DEFAULT_ACCENT);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark" || stored === "system") setThemeState(stored);
      setAccentState(presetFor(readAccentChoice(localStorage)).id);
    } catch { /* Storage can be disabled; the defaults remain. */ }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    applyTheme(theme);
    paintAccent(accent, theme);
    if (theme === "system") {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const update = () => { applyTheme("system"); paintAccent(accent, "system"); };
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
  }, [ready, theme, accent]);
  const setTheme = useCallback((next: Theme) => {
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Keep the current in-memory selection. */ }
    setThemeState(next);
  }, []);
  const setAccent = useCallback((id: string) => {
    const preset = presetFor(id);
    let storage: Storage | null = null;
    try { storage = localStorage; } catch { /* Storage can be refused: the choice then lasts for this visit only. */ }
    writeAccentChoice(storage, preset.id);
    setAccentState(preset.id);
  }, []);
  const value = useMemo(() => ({ theme, setTheme, accent, setAccent }), [theme, setTheme, accent, setAccent]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() { return useContext(ThemeContext); }

// The presets, as data for the script that runs before paint, so the saved accent is in place on the first frame.
const PRESET_TABLE = JSON.stringify(ACCENT_PRESETS);

/* Runs before paint. The theme follows the stored choice; with none, it follows the operating system. The saved accent is then set. */
export const themeBootstrap = `(()=>{try{let t="system";try{t=localStorage.getItem("${STORAGE_KEY}")||"system"}catch{}const d=t==="light"?false:t==="dark"?true:matchMedia("(prefers-color-scheme: dark)").matches;const r=document.documentElement;r.setAttribute("data-theme",d?"dark":"light");r.style.colorScheme=d?"dark":"light";let a="${DEFAULT_ACCENT}";try{a=localStorage.getItem("${ACCENT_KEY}")||a}catch{}const table=${PRESET_TABLE};const p=table.find(x=>x.id===a)||table[0];const v=d?p.dark:p.light;const s=r.style;s.setProperty("--accent",v.accent);s.setProperty("--accent-hover",v.hover);s.setProperty("--accent-text",v.text);s.setProperty("--accent-muted",v.muted);s.setProperty("--on-accent",v.on)}catch{}})();`;
