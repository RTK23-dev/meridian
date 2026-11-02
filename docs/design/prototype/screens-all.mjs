// Every screen of the walkthrough, in the order the index lists them within each group. The base screens and the cover are in screens.mjs;
// each other module adds its own. The index groups them by the five places of the proposal, plus Start (before sign-in), States (the
// pages a person meets when a screen cannot be shown) and Overlay (the command palette).
import { COVER, BASE_SCREENS } from "./screens.mjs";
import { START_SCREENS, STATES_SCREENS } from "./screens-start.mjs";
import { WORKSPACE_SCREENS } from "./screens-workspace.mjs";
import { BRAND_SCREENS } from "./screens-brand.mjs";
import { SETTINGS_SCREENS } from "./screens-settings.mjs";

export const SCREENS = [...BASE_SCREENS, ...START_SCREENS, ...STATES_SCREENS, ...WORKSPACE_SCREENS, ...BRAND_SCREENS, ...SETTINGS_SCREENS];

/** The index, in order: a group label and the screen ids in it. The cover is first in Start. */
export const GROUPS = ["Start", "Home", "Create", "Library", "Insights", "Settings", "States", "Overlay"].map((name) => ({
  label: name,
  ids: [...(name === "Start" ? [COVER] : []), ...SCREENS.filter((s) => s.group === name)].map((s) => s.id),
}));
