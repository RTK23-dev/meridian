// The style kits of the code-drawn styles: the colours, fonts, motion level and allowed shot types each style module draws with, in the
// engine's style kit contract (contracts/kits.ts), so a cookbook can name its kit and a theme page or a chat can read it. The values are
// the style modules' own (chosen for Meridian; each module's header says the same). These styles were designed from a written description
// of each look, not measured from a reference video, so they are not style presets (presets/ holds only measured ones).

import type { StyleKit } from "../../contracts/index.ts";
import type { CodedStyle } from "./specs.ts";

const base = { version: 1, stickers: [] as string[] };

export const CODED_STYLE_KITS: Readonly<Record<CodedStyle, StyleKit>> = {
  isometric: {
    ...base,
    styleKitId: "sk_isometric_explainer",
    pageId: "style_isometric_explainer",
    palette: { primary: "#3B6FB6", secondary: "#F2B33D", accent: "#E05A47", text: "#1F2A44", background: "#F2EADB" },
    fonts: { display: "Inter Display", body: "Inter", captions: "Inter" },
    captionStyle: { component: "captions.minimal", highlight: "#F2B33D", weight: 700, case: "sentence" },
    motionIntensity: 2,
    preferredTypes: ["coded_graphics", "kinetic_type"],
    bannedTypes: ["ugc_presenter", "stock_footage", "react_clip", "cinematic"],
    musicGenres: ["electronic pulse"],
    outroMs: 850,
  },
  paper_cut: {
    ...base,
    styleKitId: "sk_paper_cut_story",
    pageId: "style_paper_cut_story",
    palette: { primary: "#22365F", secondary: "#F3E9C9", accent: "#E5523B", text: "#F3E9C9", background: "#0F1A33" },
    fonts: { display: "Charter", body: "Charter", captions: "Charter" },
    captionStyle: { component: "captions.minimal", highlight: "#E5523B", weight: 400, case: "sentence" },
    motionIntensity: 1,
    preferredTypes: ["coded_graphics"],
    bannedTypes: ["ugc_presenter", "stock_footage", "react_clip", "cinematic", "product_hero"],
    musicGenres: ["ambient pad"],
    outroMs: 900,
  },
  line_diagram: {
    ...base,
    styleKitId: "sk_line_diagram",
    pageId: "style_line_diagram",
    palette: { primary: "#EAF0FA", secondary: "#7F8AA3", accent: "#F2A33D", text: "#EAF0FA", background: "#0E1A33" },
    fonts: { display: "Inter Display", body: "Inter", captions: "Inter" },
    captionStyle: { component: "captions.minimal", highlight: "#F2A33D", weight: 500, case: "sentence" },
    motionIntensity: 1,
    preferredTypes: ["coded_graphics", "kinetic_type"],
    bannedTypes: ["ugc_presenter", "stock_footage", "react_clip", "cinematic", "product_hero"],
    musicGenres: ["minimal pluck"],
    outroMs: 850,
  },
  stacked_chart: {
    ...base,
    styleKitId: "sk_stacked_data_chart",
    pageId: "style_stacked_data_chart",
    palette: { primary: "#E9B949", secondary: "#4E9F6B", accent: "#4F7FD6", text: "#F4F1E8", background: "#0B1530" },
    fonts: { display: "Inter Display", body: "Inter", captions: "Inter" },
    captionStyle: { component: "captions.minimal", highlight: "#E9B949", weight: 700, case: "sentence" },
    motionIntensity: 2,
    preferredTypes: ["coded_graphics", "kinetic_type"],
    bannedTypes: ["ugc_presenter", "stock_footage", "react_clip", "cinematic"],
    musicGenres: ["downtempo groove"],
    outroMs: 850,
  },
};
