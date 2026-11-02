// The accent: the one colour the design gives its single action, its focus and its selected state. The reader chooses one of these presets,
// and the choice changes the accent everywhere on the page: the buttons, the selected tab and step, the focus, and the globe's meridian.
// The danger colour is a state, not the accent, so it does not change. Every preset passes the contrast rules below in both themes; the
// model tests check each preset, so a preset that fails them cannot be added. The default is the red of the proposal.

/** Each preset gives five values per theme. `on` is the label colour on the accent fill, and `text` is the accent as text on the room. */
export const ACCENT_PRESETS = Object.freeze([
  {
    id: "red", label: "Red",
    dark: { accent: "#FF2E38", hover: "#FF5A63", text: "#FF2E38", muted: "#2A0B0F", on: "#000000" },
    light: { accent: "#C8102E", hover: "#A50D25", text: "#C8102E", muted: "#FBE3E6", on: "#FFFFFF" },
  },
  {
    id: "blue", label: "Blue",
    dark: { accent: "#4D9DFF", hover: "#74B5FF", text: "#4D9DFF", muted: "#0B1B2E", on: "#000000" },
    light: { accent: "#1D5FD6", hover: "#1749A8", text: "#1D5FD6", muted: "#E4EEFD", on: "#FFFFFF" },
  },
  {
    id: "violet", label: "Violet",
    dark: { accent: "#A77BFF", hover: "#BC9AFF", text: "#A77BFF", muted: "#1C1230", on: "#000000" },
    light: { accent: "#6B3FD1", hover: "#5630AE", text: "#6B3FD1", muted: "#EFE9FD", on: "#FFFFFF" },
  },
  {
    id: "teal", label: "Teal",
    dark: { accent: "#2DD4BF", hover: "#5EE3D1", text: "#2DD4BF", muted: "#0B2723", on: "#000000" },
    light: { accent: "#0F766E", hover: "#0B5E58", text: "#0F766E", muted: "#E0F5F2", on: "#FFFFFF" },
  },
  {
    id: "magenta", label: "Magenta",
    dark: { accent: "#F472B6", hover: "#F793C9", text: "#F472B6", muted: "#2C0F1E", on: "#000000" },
    light: { accent: "#A3176A", hover: "#861356", text: "#A3176A", muted: "#FBE4F1", on: "#FFFFFF" },
  },
]);

export const ACCENT_KEY = "meridian-accent";
export const DEFAULT_ACCENT = "red";

/** The preset with this id, or the default when the id is not one of the presets (for example, a value saved by an older page). */
export const presetFor = (id) => ACCENT_PRESETS.find((preset) => preset.id === id) ?? ACCENT_PRESETS[0];

/** The theme the page is drawn in: an explicit choice wins, and otherwise the system setting decides. */
export const effectiveTheme = (dataTheme, prefersLight) => (dataTheme === "light" || dataTheme === "dark" ? dataTheme : prefersLight ? "light" : "dark");

/** The five custom properties a preset sets for one theme. */
export const accentTokens = (preset, theme) => {
  const values = preset[theme];
  return { "--accent": values.accent, "--accent-hover": values.hover, "--accent-text": values.text, "--accent-muted": values.muted, "--on-accent": values.on };
};

/** The relative luminance of a #RRGGBB colour, by the WCAG formula. */
export const luminance = (hex) => {
  const channel = (value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** The contrast ratio of two #RRGGBB colours, from 1 to 21. */
export const contrast = (a, b) => {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

/** Writes a preset's values for one theme onto the root element. Inline values win over the stylesheet, so the choice holds in both themes. */
export function applyAccent(root, preset, theme) {
  for (const [name, value] of Object.entries(accentTokens(preset, theme))) root.style.setProperty(name, value);
}

/** The saved choice, or null. Storage can be refused, so a refusal reads as no choice and a failed save lasts for this visit only. */
export function readAccentChoice(storage) {
  try { return storage.getItem(ACCENT_KEY); } catch { return null; }
}
export function writeAccentChoice(storage, id) {
  try { storage.setItem(ACCENT_KEY, id); } catch { /* refused: the choice lasts until the page is closed */ }
}

/**
 * Draws the accent control in `[data-accent-picker]`, restores the saved choice, and keeps the page's accent in step with the theme.
 * The control is a radio group of swatches; the swatch shows the preset's dark-theme colour, so each one is visible on either background.
 */
export function wireAccent(doc, win) {
  const root = doc.documentElement;
  const picker = doc.querySelector("[data-accent-picker]");
  const storageOf = () => { try { return win.localStorage; } catch { return null; } };
  let current = presetFor(readAccentChoice(storageOf()) ?? DEFAULT_ACCENT);
  const prefersLight = () => win.matchMedia("(prefers-color-scheme: light)");

  if (picker) {
    picker.innerHTML = ACCENT_PRESETS.map((preset) => `<button type="button" role="radio" aria-checked="false" data-set-accent="${preset.id}"><span class="swatch" style="background:${preset.dark.accent}" aria-hidden="true"></span>${preset.label}</button>`).join("");
    for (const button of picker.querySelectorAll("[data-set-accent]")) {
      button.addEventListener("click", () => {
        current = presetFor(button.dataset.setAccent);
        writeAccentChoice(storageOf(), current.id);
        paint();
      });
    }
  }

  function paint() {
    applyAccent(root, current, effectiveTheme(root.dataset.theme, prefersLight().matches));
    if (picker) for (const button of picker.querySelectorAll("[data-set-accent]")) button.setAttribute("aria-checked", String(button.dataset.setAccent === current.id));
  }

  new win.MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  prefersLight().addEventListener("change", paint);
  paint();
}
