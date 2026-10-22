// The design style the whole app is drawn in: AttentionOS (the default) or Katana. The style sets data-design on <html>. Its
// colours, faces, radii and motion are declared in src/styles.css, so no component chooses a style itself. This module holds
// only the pure parts, so the tests can read them without a browser.

export const DESIGN_STYLES = ["katana", "attentionos"] as const;
export type DesignStyle = (typeof DESIGN_STYLES)[number];
export const DEFAULT_DESIGN_STYLE: DesignStyle = "katana";
export const DESIGN_STORAGE_KEY = "meridian-design-style";

/** The style a stored or submitted value names, or the default when it names none. */
export function parseDesignStyle(value: unknown): DesignStyle {
  return (DESIGN_STYLES as readonly unknown[]).includes(value) ? (value as DesignStyle) : DEFAULT_DESIGN_STYLE;
}

/** What Settings says about each style, and the three colours of its preview (dark theme). */
export const DESIGN_STYLE_INFO: Record<DesignStyle, { name: string; summary: string; preview: { accent: string; surface: string; text: string } }> = {
  attentionos: {
    name: "AttentionOS",
    summary: "Violet accent, rounded corners (6 to 24px), Sora headings with Inter text.",
    preview: { accent: "#7838E8", surface: "#111016", text: "#F6F3FC" },
  },
  katana: {
    name: "Katana",
    summary: "Red accent, square corners (2px), Archivo headings with Instrument Sans text. The default.",
    preview: { accent: "#FF2E38", surface: "#0E0E0E", text: "#FFFFFF" },
  },
};

/** Runs before paint, so the first frame already has the stored style. Unreadable storage keeps the default. */
export const designStyleBootstrap = `(()=>{try{const list=${JSON.stringify(DESIGN_STYLES)};let s="${DEFAULT_DESIGN_STYLE}";try{const v=localStorage.getItem("${DESIGN_STORAGE_KEY}");if(list.includes(v))s=v}catch{}document.documentElement.setAttribute("data-design",s)}catch{}})();`;
