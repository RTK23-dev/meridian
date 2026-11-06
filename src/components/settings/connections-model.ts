/**
 * The Connections view, as a pure model: one row per provider (its key and its state) and one row per place in Meridian that needs a
 * provider (what serves it, and whether that works). It reads the server's own provider summaries and decision-engine status, so
 * every light is the resolver's state, never a guess, and the model never sees a key.
 *
 * Lights: working, shown as Ready (the provider this feature uses has a key that can be read; it is not checked against the provider
 * until it is used), missing (no usable provider), overlap (more than one usable provider
 * could serve it: the row says which one is used), optional (an optional feature with nothing set).
 *
 * OpenRouter is the main key: it serves every text, image, video and voice model the writing tools and the video engine use, and one
 * decision engine. The features it does not serve yet are named, with the key each one needs.
 */
import type { ProviderCategory, ProviderConfigSummary } from "@/lib/meridian/settings/provider-config";
import type { CredentialCategory } from "../../lib/meridian/credentials/contract.ts";

export type ProviderId =
  | "openrouter"
  | "google"
  | "typesafe"
  | "openai"
  | "anthropic"
  | "deepgram"
  | "heygen"
  | "hypit"
  | "meta_ad_library"
  | "apify"
  | "youtube"
  | "tiktok"
  | "instagram"
  | "meta_graph"
  | "twitter"
  | "linkedin"
  | "pinterest"
  | "search"
  | "licensed"
  | "shopify"
  | "drive";

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  /** The vault categories one key is saved to. Google's one key serves both perception and production. Empty for a server-set row. */
  categories: CredentialCategory[];
  /** What the key powers, in one short line. */
  powers: string;
  /** Where to get a key, when there is a public page for it. */
  keyUrl: string | null;
  /** Shown under "More providers" instead of the main list. */
  more?: true;
  /** Set on the server, not in this screen (the row has no key field). */
  serverOnly?: true;
};

export const PROVIDERS: readonly ProviderInfo[] = [
  { id: "openrouter", label: "OpenRouter", categories: ["openrouter"], powers: "Every text, image, video and voice model: writing, image understanding, the video engine, and OpenRouter decisions.", keyUrl: "https://openrouter.ai/keys" },
  { id: "google", label: "Google Gemini", categories: ["perception", "production"], powers: "Studio images and video (Gemini Omni), and reference analysis (perception). One key serves both.", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "typesafe", label: "TypeSafe JEV", categories: ["jev"], powers: "The TypeSafe JEV decision engine.", keyUrl: null },
  { id: "openai", label: "OpenAI", categories: ["openai"], powers: "The OpenAI Decisions engine. OpenAI's other models are reached through OpenRouter.", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "deepgram", label: "Deepgram", categories: ["deepgram"], powers: "Speech to text for the video engine.", keyUrl: "https://console.deepgram.com" },
  { id: "heygen", label: "HeyGen", categories: ["heygen"], powers: "Cloud rendering of finished videos (HyperFrames).", keyUrl: "https://app.heygen.com/settings" },
  { id: "meta_ad_library", label: "Meta Ad Library", categories: ["meta_ad_library"], powers: "Reading competitors' public ads for research.", keyUrl: null },
  { id: "anthropic", label: "Anthropic", categories: ["anthropic"], powers: "Claude directly. Every route uses Claude through OpenRouter today, so this key is only for moving a route back.", keyUrl: "https://console.anthropic.com/settings/keys", more: true },
  { id: "hypit", label: "Hypit", categories: ["hypit"], powers: "Hypit video, a separate server process. It also needs HYPIT_BASE_URL on the server.", keyUrl: null, more: true },
  { id: "apify", label: "Apify", categories: ["apify"], powers: "Instagram research at volume.", keyUrl: null, more: true },
  { id: "youtube", label: "YouTube", categories: ["youtube"], powers: "YouTube research.", keyUrl: null, more: true },
  { id: "tiktok", label: "TikTok", categories: ["tiktok"], powers: "TikTok research.", keyUrl: null, more: true },
  { id: "instagram", label: "Instagram", categories: ["instagram"], powers: "Instagram research.", keyUrl: null, more: true },
  { id: "meta_graph", label: "Meta Graph", categories: ["meta_graph"], powers: "Meta page and post research.", keyUrl: null, more: true },
  { id: "twitter", label: "X (Twitter)", categories: ["twitter"], powers: "X research.", keyUrl: null, more: true },
  { id: "linkedin", label: "LinkedIn", categories: ["linkedin"], powers: "LinkedIn research.", keyUrl: null, more: true },
  { id: "pinterest", label: "Pinterest", categories: ["pinterest"], powers: "Pinterest research.", keyUrl: null, more: true },
  { id: "search", label: "Search API", categories: ["search"], powers: "Web search for research.", keyUrl: null, more: true },
  { id: "licensed", label: "Licensed ad data", categories: ["licensed"], powers: "A licensed ad data feed.", keyUrl: null, more: true },
  { id: "shopify", label: "Shopify", categories: ["shopify"], powers: "Shopify orders, through the order webhook's secret.", keyUrl: null, more: true },
  { id: "drive", label: "Google Drive", categories: [], powers: "Where files are kept. Set on the server; without it files stay on the server's disk.", keyUrl: null, more: true, serverOnly: true },
];

export type ProviderStatus = "ready" | "shared" | "partial" | "unusable" | "none";

export type ProviderRow = ProviderInfo & {
  status: ProviderStatus;
  /** The masked fingerprint of the key in use, or null. */
  fingerprint: string | null;
  /** Why it cannot be used, or what is partial. Null when ready. */
  reason: string | null;
  /** True when a workspace key is saved, so an admin can remove it. */
  removable: boolean;
  /** The features this provider is the one in use for. */
  usedFor: string[];
  /** True when the key is usable but no feature uses it right now (it overlaps another provider). */
  unused: boolean;
};

export type FeatureGroup = "write" | "video" | "studio" | "research" | "other";

export const FEATURE_GROUPS: ReadonlyArray<{ id: FeatureGroup; label: string }> = [
  { id: "write", label: "Writing and decisions" },
  { id: "video", label: "Video engine (Create)" },
  { id: "studio", label: "Studio and analysis" },
  { id: "research", label: "Research sources" },
  { id: "other", label: "Files and orders" },
];

type FeatureInfo = {
  id: string;
  label: string;
  group: FeatureGroup;
  /** The providers that can serve it, in the order the runtime prefers them. */
  candidates: ProviderId[];
  /** How the provider is chosen: fixed by the code, or by the workspace's decision engine. */
  choice: "fixed" | "decision_engine";
  optional?: true;
  /**
   * The model seat (Settings, Models) OpenRouter needs for this feature. OpenRouter serves the feature only once a model is chosen there,
   * and then it comes first: an explicit choice wins over the feature's own provider.
   */
  modelTask?: string;
  /** One line for the info button. */
  about: string;
};

export const FEATURES: readonly FeatureInfo[] = [
  { id: "writing", label: "Scripts and copy", group: "write", candidates: ["openrouter"], choice: "fixed", about: "Writes scripts, copy, script ideas and their judging, with the models chosen under Models." },
  { id: "research_analysis", label: "Research analysis", group: "write", candidates: ["openrouter"], choice: "fixed", about: "Analyses the transcripts of collected ads." },
  { id: "brand_brain", label: "Brand brain suggestions", group: "write", candidates: ["openrouter"], choice: "fixed", about: "Suggests brand brain fields from a stored page." },
  { id: "image_understanding", label: "Image understanding", group: "write", candidates: ["openrouter"], choice: "fixed", about: "Labels Factory keyframes with a model that reads images." },
  { id: "decisions", label: "Decisions and scoring", group: "write", candidates: ["openrouter", "typesafe", "openai"], choice: "decision_engine", about: "Answers Meridian's choice and score questions. One engine answers them; choose which." },
  { id: "video_direction", label: "Video planning and direction", group: "video", candidates: ["openrouter"], choice: "fixed", about: "The video engine's director, planner and checks, on Claude through OpenRouter." },
  { id: "video_images", label: "Video images", group: "video", candidates: ["openrouter"], choice: "fixed", about: "Keyframes and stills for videos." },
  { id: "video_clips", label: "Video clips", group: "video", candidates: ["openrouter"], choice: "fixed", about: "Generated video shots (Kling, Seedance, Wan and others on OpenRouter)." },
  { id: "voice", label: "Voice-over", group: "video", candidates: ["openrouter"], choice: "fixed", about: "Text to speech for the voice track." },
  { id: "transcription", label: "Speech to text", group: "video", candidates: ["deepgram"], choice: "fixed", about: "Transcribes a reference or an upload for the video engine." },
  { id: "cloud_render", label: "Cloud rendering", group: "video", candidates: ["heygen"], choice: "fixed", optional: true, about: "Renders finished videos in the cloud (HyperFrames)." },
  { id: "studio_images", label: "Studio images", group: "studio", candidates: ["google"], choice: "fixed", about: "Creative images in the Studio (Google Nano Banana)." },
  { id: "studio_video", label: "Studio video", group: "studio", candidates: ["google"], choice: "fixed", about: "Studio videos with Gemini Omni. Hypit and Higgsfield run as server-set options." },
  { id: "perception", label: "Reference analysis", group: "studio", candidates: ["google", "openrouter"], choice: "fixed", modelTask: "reference_analysis", about: "Reads reference images and video frames: shot, product, on-screen text. Through OpenRouter, with the model chosen under Models; otherwise with a Google Gemini key." },
  { id: "ad_library", label: "Competitor ad research", group: "research", candidates: ["meta_ad_library"], choice: "fixed", about: "Reads the public Meta Ad Library." },
  {
    id: "social_sources",
    label: "Social and web research",
    group: "research",
    candidates: ["apify", "youtube", "tiktok", "instagram", "meta_graph", "twitter", "linkedin", "pinterest", "search", "licensed"],
    choice: "fixed",
    optional: true,
    about: "Each connector reads its own source. Public web pages need no key.",
  },
  { id: "storage", label: "File storage", group: "other", candidates: ["drive"], choice: "fixed", optional: true, about: "Google Drive when the server sets it; otherwise files stay on the server's disk." },
  { id: "orders", label: "Shopify orders", group: "other", candidates: ["shopify"], choice: "fixed", optional: true, about: "Receives orders through Shopify's webhook." },
];

export type FeatureLight = "working" | "missing" | "overlap" | "optional";

export type FeatureRow = FeatureInfo & {
  light: FeatureLight;
  /** The provider this feature uses now, or null when none can serve it. */
  usedProvider: ProviderId | null;
  /** The usable providers that could serve it, beyond the one used. */
  alsoUsable: ProviderId[];
  /** One plain line: what serves it, or what it needs. */
  line: string;
};

/** The decision engine status the model reads. */
export type EngineStatus = {
  active: { engineId: string };
  engines: ReadonlyArray<{ id: string; health: { status: string } }>;
  /** The OpenRouter decision model; source "none" means no model is chosen yet, so OpenRouter cannot decide until one is. */
  openrouterModel?: { model: string; source: string };
};

const ENGINE_PROVIDER: Record<string, ProviderId> = { jev: "typesafe", "openai-decisions": "openai", "openrouter-decisions": "openrouter" };
export const PROVIDER_ENGINE: Partial<Record<ProviderId, string>> = { typesafe: "jev", openai: "openai-decisions", openrouter: "openrouter-decisions" };

const labelOf = (id: ProviderId) => PROVIDERS.find((provider) => provider.id === id)?.label ?? id;

function categoryState(summary: ProviderConfigSummary | undefined): { state: "usable" | "unusable" | "not_configured"; workspace: boolean; fingerprint: string | null; reason: string | null } {
  if (!summary) return { state: "not_configured", workspace: false, fingerprint: null, reason: null };
  const state = summary.credentialState ?? (summary.configured ? "usable" : "not_configured");
  return {
    state: state === "usable" ? "usable" : state === "unusable" ? "unusable" : "not_configured",
    workspace: summary.source === "workspace",
    fingerprint: state === "usable" ? summary.keyFingerprint ?? null : null,
    reason: state === "usable" ? null : summary.credentialReason ?? null,
  };
}

function providerState(info: ProviderInfo, summaries: Partial<Record<ProviderCategory, ProviderConfigSummary>>): Omit<ProviderRow, keyof ProviderInfo | "usedFor" | "unused"> {
  if (info.id === "drive") {
    const configured = summaries.storage?.configured === true;
    return { status: configured ? "shared" : "none", fingerprint: null, reason: configured ? null : "Not set on the server: files stay on the server's disk.", removable: false };
  }
  const states = info.categories.map((category) => categoryState(summaries[category]));
  const usable = states.filter((state) => state.state === "usable");
  const unusable = states.find((state) => state.state === "unusable");
  const removable = states.some((state) => state.workspace && state.state !== "not_configured");
  const fingerprint = usable[0]?.fingerprint ?? null;
  if (unusable) return { status: "unusable", fingerprint, reason: unusable.reason ?? "The saved key cannot be used. Save it again.", removable };
  if (info.id === "hypit" && summaries.hypit && !summaries.hypit.settings?.baseUrlConfigured) {
    return { status: usable.length > 0 ? "partial" : "none", fingerprint, reason: "HYPIT_BASE_URL is not set on the server.", removable };
  }
  if (usable.length === 0) return { status: "none", fingerprint: null, reason: null, removable };
  if (usable.length < states.length) return { status: "partial", fingerprint, reason: "Saved for only part of what it serves. Save the key again to use it for both.", removable };
  const shared = usable.every((state) => !state.workspace);
  return { status: shared ? "shared" : "ready", fingerprint, reason: null, removable };
}

const isUsable = (status: ProviderStatus) => status === "ready" || status === "shared";

/** The whole view: providers with their state and use, and features with their light. */
export function connectionsView(input: {
  summaries: Partial<Record<ProviderCategory, ProviderConfigSummary>>;
  engines: EngineStatus | null;
  /** The model seats the workspace has chosen a model for (Settings, Models). */
  chosenTasks?: ReadonlySet<string>;
}): { providers: ProviderRow[]; features: FeatureRow[]; openRouterUnlocks: { count: number; of: number; missing: string[] } } {
  const states = new Map(PROVIDERS.map((info) => [info.id, providerState(info, input.summaries)]));
  const usable = (id: ProviderId) => isUsable(states.get(id)?.status ?? "none");
  const chosen = (task: string | undefined) => task !== undefined && (input.chosenTasks?.has(task) ?? false);

  const features: FeatureRow[] = FEATURES.map((feature) => {
    // OpenRouter serves a feature with a model seat only once that seat has a model, and then it comes first, as the runtime does.
    const servable = (id: ProviderId) => usable(id) && !(id === "openrouter" && feature.modelTask !== undefined && !chosen(feature.modelTask));
    const order = feature.modelTask && chosen(feature.modelTask) ? ["openrouter" as ProviderId, ...feature.candidates.filter((id) => id !== "openrouter")] : feature.candidates;
    const ready = order.filter(servable);
    let used: ProviderId | null;
    if (feature.choice === "decision_engine") {
      const engineProvider = input.engines ? ENGINE_PROVIDER[input.engines.active.engineId] ?? null : null;
      const engineReady = input.engines?.engines.find((engine) => engine.id === input.engines?.active.engineId)?.health.status === "READY";
      used = engineProvider && (engineReady || usable(engineProvider)) ? engineProvider : null;
    } else {
      used = ready[0] ?? null;
    }
    // Storage always works: the server's disk is the fallback when Drive is not set.
    if (feature.id === "storage" && used === null) {
      return { ...feature, light: "working", usedProvider: null, alsoUsable: [], line: "Server disk (Google Drive is not set)" };
    }
    const alsoUsable = ready.filter((id) => id !== used);
    let light: FeatureLight;
    if (used === null) light = feature.optional ? "optional" : "missing";
    else light = alsoUsable.length > 0 ? "overlap" : "working";
    let line: string;
    if (used !== null) {
      line = alsoUsable.length > 0 ? `${labelOf(used)} (also set: ${alsoUsable.map(labelOf).join(", ")})` : labelOf(used);
    } else if (feature.choice === "decision_engine" && input.engines) {
      const engineProvider = ENGINE_PROVIDER[input.engines.active.engineId];
      line = engineProvider ? `${labelOf(engineProvider)} is chosen but has no key` : "No engine chosen";
    } else if (feature.modelTask && usable("openrouter")) {
      line = "Choose a model under Models";
    } else {
      line = feature.optional ? "Not set (optional)" : `Needs ${feature.candidates.slice(0, 2).map(labelOf).join(" or ")}`;
    }
    return { ...feature, light, usedProvider: used, alsoUsable, line };
  });

  const providers: ProviderRow[] = PROVIDERS.map((info) => {
    const state = states.get(info.id)!;
    const usedFor = features.filter((feature) => feature.usedProvider === info.id).map((feature) => feature.label);
    return { ...info, ...state, usedFor, unused: isUsable(state.status) && usedFor.length === 0 && !info.serverOnly };
  });

  const openRouterFeatures = FEATURES.filter((feature) => feature.candidates.includes("openrouter"));
  const missing = FEATURES.filter((feature) => !feature.candidates.includes("openrouter") && !feature.optional).map((feature) => feature.label);
  return { providers, features, openRouterUnlocks: { count: openRouterFeatures.length, of: FEATURES.length, missing } };
}
