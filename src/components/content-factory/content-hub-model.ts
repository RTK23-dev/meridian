// The one content page: the sections it has, the modes a person can start in, and the search values that open it.
// Pure, so these rules are tested without a screen. Each section's screen keeps its own role checks.

export const CONTENT_SECTIONS = ["create", "ads", "ideas", "review", "library", "publish", "results"] as const;

export type ContentSection = (typeof CONTENT_SECTIONS)[number];

export const CONTENT_SECTION_LABELS: Record<ContentSection, string> = {
  create: "Create",
  ideas: "Ideas",
  review: "Review",
  library: "Library",
  publish: "Publish",
  results: "Results",
  ads: "Batch",
};

// Only an admin of the workspace sees these sections. The screens behind them still check their own roles.
const ADMIN_SECTIONS: readonly ContentSection[] = ["ads"];

export function isContentSection(value: unknown): value is ContentSection {
  return typeof value === "string" && (CONTENT_SECTIONS as readonly string[]).includes(value);
}

export function sectionOf(value: unknown, fallback: ContentSection = "create"): ContentSection {
  return isContentSection(value) ? value : fallback;
}

export function sectionsFor(isAdmin: boolean): ContentSection[] {
  return CONTENT_SECTIONS.filter((section) => isAdmin || !ADMIN_SECTIONS.includes(section));
}

// A preset is a starting mode for the Create section. "engine" makes a video in a chat session through the video engine.
// "studio" makes images and videos from a brief in Studio.
export type CreateMode = "engine" | "studio";

export type CreatePreset = {
  id: string;
  mode: CreateMode;
  label: string;
  description: string;
  adminOnly: boolean;
};

// The simplest start comes first, so an admin's Create section opens on it.
export const CREATE_PRESETS: readonly CreatePreset[] = [
  {
    id: "brief",
    mode: "engine",
    label: "Video from a brief",
    description: "Describe the video. The engine writes the script, plans the shots and renders them.",
    adminOnly: true,
  },
  {
    id: "reference",
    mode: "engine",
    label: "Video from a reference",
    description: "Attach a video you like. The engine plans a new one in the same style.",
    adminOnly: true,
  },
  {
    id: "studio",
    mode: "studio",
    label: "Images and videos in Studio",
    description: "Make images and videos from a brief, with the providers this workspace has connected.",
    adminOnly: false,
  },
];

export function presetsFor(isAdmin: boolean): CreatePreset[] {
  return CREATE_PRESETS.filter((preset) => isAdmin || !preset.adminOnly);
}

// The preset a person starts in: the first one they can use. Members start in Studio, admins in the engine.
export function defaultPreset(isAdmin: boolean): CreatePreset {
  return presetsFor(isAdmin)[0] ?? CREATE_PRESETS[CREATE_PRESETS.length - 1];
}

export type ContentSearch = { section?: ContentSection; preset?: string; session?: string };

// Reads the search values the page accepts. Anything else is dropped rather than trusted.
export function contentSearchOf(search: Record<string, unknown>): ContentSearch {
  const out: ContentSearch = {};
  if (isContentSection(search.section)) out.section = search.section;
  if (typeof search.preset === "string" && search.preset !== "" && search.preset.length <= 40) out.preset = search.preset;
  if (typeof search.session === "string" && search.session !== "" && search.session.length <= 80) out.session = search.session;
  return out;
}

// The section a page opens in when the address names none. Admins start in Batch, but an address that names an engine session is
// a link to that session (an opportunity's brief makes one), and a session lives in Create, so it opens there.
export function defaultSectionFor(isAdmin: boolean, search: ContentSearch): ContentSection {
  return isAdmin && search.session === undefined ? "ads" : "create";
}

// Moving between sections keeps the starting mode the person chose. The engine session belongs to Create, so it is dropped.
export function searchForSection(current: ContentSearch, section: ContentSection): ContentSearch {
  return current.preset === undefined ? { section } : { section, preset: current.preset };
}

// The screens that were separate brand pages before the content page. Each old path redirects to its section, so old links still work.
export type LegacyContentRoute = "opportunities" | "studio" | "reviews" | "library" | "accounts" | "learning" | "factory";

export const LEGACY_CONTENT_ROUTES: Record<LegacyContentRoute, ContentSearch> = {
  opportunities: { section: "ideas" },
  studio: { section: "create", preset: "studio" },
  reviews: { section: "review" },
  library: { section: "library" },
  accounts: { section: "publish" },
  learning: { section: "results" },
  factory: { section: "ads" },
};
