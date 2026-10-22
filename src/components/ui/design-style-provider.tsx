import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_DESIGN_STYLE, DESIGN_STORAGE_KEY, parseDesignStyle, type DesignStyle } from "./design-style";

const DesignStyleContext = createContext<{ style: DesignStyle; setStyle: (style: DesignStyle) => void }>({
  style: DEFAULT_DESIGN_STYLE,
  setStyle: () => undefined,
});

export function DesignStyleProvider({ children }: { children: ReactNode }) {
  const [style, setStyleState] = useState<DesignStyle>(DEFAULT_DESIGN_STYLE);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      setStyleState(parseDesignStyle(localStorage.getItem(DESIGN_STORAGE_KEY)));
    } catch { /* Storage can be disabled; the default style remains. */ }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    document.documentElement.setAttribute("data-design", style);
    // The AttentionOS faces are fetched only while that style is in use. Katana's faces are part of the stylesheet.
    if (style === "attentionos") void import("./attentionos-fonts");
  }, [ready, style]);
  const setStyle = useCallback((next: DesignStyle) => {
    try { localStorage.setItem(DESIGN_STORAGE_KEY, next); } catch { /* Keep the choice for this page view only. */ }
    setStyleState(next);
  }, []);
  const value = useMemo(() => ({ style, setStyle }), [style, setStyle]);
  return <DesignStyleContext.Provider value={value}>{children}</DesignStyleContext.Provider>;
}

export function useDesignStyle() { return useContext(DesignStyleContext); }
