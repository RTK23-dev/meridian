// The accent: the one colour the design gives what needs the reader: the selected place and step, a count waiting for them, the focus
// ring, progress and a screen's one hero element (the canvas system, docs/design/KATANA_CANVAS_SYSTEM.md). The main action is ink, not
// the accent. The reader chooses one of these presets, and the choice changes the accent everywhere in the app. The danger colour is a state, not the accent, so it does not change. Every preset passes the contrast rules in both
// themes, and the tests check each preset, so a preset that fails them cannot be added. The default is the red of the design.
// This is the app's copy of docs/design/prototype/accent.mjs; the two must keep the same values, and a test in this folder checks them.

export type AccentTheme = "dark" | "light";
export type AccentValues = { accent: string; hover: string; text: string; muted: string; on: string };
export type AccentPreset = { id: string; label: string; dark: AccentValues; light: AccentValues };

export const ACCENT_PRESETS: readonly AccentPreset[] = Object.freeze([
  {
    id: "red", label: "Red",
    dark: { accent: "#E0573A", hover: "#E9705A", text: "#EE7A5F", muted: "#2B1410", on: "#000000" },
    light: { accent: "#D2462A", hover: "#DE5E43", text: "#922B15", muted: "#F3D6CD", on: "#000000" },
  },
  {
    id: "blue", label: "Blue",
    dark: { accent: "#4D9DFF", hover: "#74B5FF", text: "#4D9DFF", muted: "#0B1B2E", on: "#000000" },
    light: { accent: "#1D5FD6", hover: "#1749A8", text: "#123F8F", muted: "#DCE6F7", on: "#FFFFFF" },
  },
  {
    id: "violet", label: "Violet",
    dark: { accent: "#A77BFF", hover: "#BC9AFF", text: "#A77BFF", muted: "#1C1230", on: "#000000" },
    light: { accent: "#6B3FD1", hover: "#5630AE", text: "#4B2A96", muted: "#E8E0F7", on: "#FFFFFF" },
  },
  {
    id: "teal", label: "Teal",
    dark: { accent: "#2DD4BF", hover: "#5EE3D1", text: "#2DD4BF", muted: "#0B2723", on: "#000000" },
    light: { accent: "#0F766E", hover: "#0B5E58", text: "#0A524D", muted: "#D8EEEA", on: "#FFFFFF" },
  },
  {
    id: "magenta", label: "Magenta",
    dark: { accent: "#F472B6", hover: "#F793C9", text: "#F472B6", muted: "#2C0F1E", on: "#000000" },
    light: { accent: "#A3176A", hover: "#861356", text: "#7A1150", muted: "#F4DCEA", on: "#FFFFFF" },
  },
]);

export const ACCENT_KEY = "meridian-accent";
export const DEFAULT_ACCENT = "red";

/** The preset with this id, or the default when the id is not one of the presets (for example, a value saved by an older version). */
export function presetFor(id: string | null | undefined): AccentPreset {
  return ACCENT_PRESETS.find((preset) => preset.id === id) ?? ACCENT_PRESETS[0];
}

/** The five custom properties a preset sets for one theme. */
export function accentTokens(preset: AccentPreset, theme: AccentTheme): Record<string, string> {
  const values = preset[theme];
  return { "--accent": values.accent, "--accent-hover": values.hover, "--accent-text": values.text, "--accent-muted": values.muted, "--on-accent": values.on };
}

/** Writes a preset's values for one theme onto the root element. Inline values win over the stylesheet, so the choice holds in both themes. */
export function applyAccent(root: HTMLElement, preset: AccentPreset, theme: AccentTheme): void {
  for (const [name, value] of Object.entries(accentTokens(preset, theme))) root.style.setProperty(name, value);
}

/** The saved choice, or null. Storage can be refused, so a refusal reads as no choice. */
export function readAccentChoice(storage: Pick<Storage, "getItem"> | null): string | null {
  try { return storage?.getItem(ACCENT_KEY) ?? null; } catch { return null; }
}

/** Saves the choice. A refused save lasts until the page is closed. */
export function writeAccentChoice(storage: Pick<Storage, "setItem"> | null, id: string): void {
  try { storage?.setItem(ACCENT_KEY, id); } catch { /* Refused: the choice lasts for this visit only. */ }
}
