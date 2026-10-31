/**
 * The guided setup, as a pure model. It turns the saved facts (the brand list, the decision engine and each provider's state)
 * into the steps a person follows, in order. Every step says what it does, why it matters, and where it stands, so nobody has
 * to guess what to set up next. The model never reads a key and never checks a live provider: it only reads the server's states.
 */

export type GuideStepId = "brand" | "engine" | "sources" | "media" | "publish" | "storage";

/**
 * done: the saved facts show it. current: the first step not yet done, the one to do now. todo: a required step after the current
 * one. optional: an optional step that is not done. unknown: the facts it depends on have not loaded, so it is not guessed.
 */
export type GuideStepStatus = "done" | "current" | "todo" | "optional" | "unknown";

/** A provider's state as the server reports it. Only the first two mean a key is in use. */
export type ProviderState = "usable" | "deployment_shared_default" | "unusable" | "not_configured";

export type GuideFacts = {
  /** The number of brands, or null while the brand list has not loaded. */
  brandCount: number | null;
  /** The decision engine status, or null while it has not loaded. `chosen` is false when no engine was picked for the workspace. */
  engine: null | { label: string; chosen: boolean; ready: boolean; reason: string };
  /** Provider states by row id, or null while the provider summaries have not loaded. */
  providers: null | Record<string, ProviderState>;
};

export type GuideStep = {
  id: GuideStepId;
  title: string;
  /** When to do it, in one short line: do it first, needed for a particular job, or safe to skip. */
  when: string;
  /** What the step is, in plain words. */
  what: string;
  /** Why it matters to the person, in one sentence. */
  why: string;
  required: boolean;
  status: GuideStepStatus;
  /** A sentence about the step as it stands now. It states the saved fact or what is missing, never a live check. */
  detail: string;
};

/** Sources a saved key makes search by phrase. Public web pages and uploads need none. TikTok, Instagram, X and the rest do nothing with a key in this release, so they are not here. */
export const KEYED_SOURCE_IDS = ["meta_ad_library", "youtube", "search"] as const;

export function isInUse(state: ProviderState | undefined): boolean {
  return state === "usable" || state === "deployment_shared_default";
}

type Definition = Omit<GuideStep, "status" | "detail">;

export const GUIDE_STEPS: readonly Definition[] = [
  {
    id: "brand",
    title: "Create your first brand",
    when: "Do this first.",
    what: "A brand is the business or product you are making videos for. All your research and videos belong to it. You only need its name and what it sells to start.",
    why: "Everything else belongs to a brand, so nothing can be made until one exists.",
    required: true,
  },
  {
    id: "engine",
    title: "Choose a decision engine",
    when: "Do this second. You need one key.",
    what: "This is the service that judges your ideas and examples. Pick one (TypeSafe JEV, OpenAI Decisions or OpenRouter), paste that service's key, and it is ready. You never need more than one.",
    why: "No idea is graded until an engine is chosen and ready.",
    required: true,
  },
  {
    id: "media",
    title: "Connect a video maker",
    when: "Needed to make videos. Skip it while you are only trying things out.",
    what: "This is the key for the service that actually renders your videos. Without it you can still plan, research and prepare drafts, and you can upload videos you already have.",
    why: "Only needed when Meridian should produce media itself.",
    required: false,
  },
  {
    id: "storage",
    title: "Connect Google Drive",
    when: "Needed to upload a reference video. Skip it otherwise.",
    what: "Drive stores the reference videos you upload and the files Meridian makes. The person who runs the server sets it up once, and every workspace on it shares it.",
    why: "Without Drive, a reference video cannot be uploaded to a draft.",
    required: false,
  },
  {
    id: "sources",
    title: "Where examples come from",
    when: "Optional. Public page URLs and uploads need no key, so you can skip this.",
    what: "To start, paste one public page URL or upload an example. Neither needs a key. Searching by phrase is optional and uses your own developer key for Meta Ad Library, YouTube or Google search. For research beyond these, Agent Reach is an optional tool an operator runs on the host (docs/AGENT_REACH.md).",
    why: "Better examples give better patterns. With no source at all, there is nothing to compare against.",
    required: false,
  },
  {
    id: "publish",
    title: "Publish your work",
    when: "Optional. Skip it: you can export and post videos yourself.",
    what: "Connect a Facebook Page, Instagram, YouTube or TikTok account to post from Meridian, or a Meta or TikTok key for paid ads. Paid ads are created paused, so nothing spends until you switch them on in that platform.",
    why: "Only needed to publish. Until then, the export holds everything Meridian made.",
    required: false,
  },
];

const SOURCE_PROVIDERS = KEYED_SOURCE_IDS;
const MEDIA_PROVIDERS = ["perception", "production"] as const;
/** The paid-ad keys that can publish. Each one is optional, and either one is enough for a paid ad. */
const PUBLISH_PROVIDERS = ["meta_graph", "tiktok"] as const;
const STORAGE_PROVIDER = "google_drive";

/** Whether each step is done, unknown, or not yet done, from the facts alone. */
function doneOf(id: GuideStepId, facts: GuideFacts): boolean | null {
  switch (id) {
    case "brand":
      return facts.brandCount === null ? null : facts.brandCount > 0;
    case "engine":
      return facts.engine === null ? null : facts.engine.chosen && facts.engine.ready;
    case "sources":
      return facts.providers === null ? null : SOURCE_PROVIDERS.some((key) => isInUse(facts.providers?.[key]));
    case "media":
      return facts.providers === null ? null : MEDIA_PROVIDERS.every((id) => isInUse(facts.providers?.[id]));
    case "publish":
      return facts.providers === null ? null : PUBLISH_PROVIDERS.some((key) => isInUse(facts.providers?.[key]));
    case "storage":
      return facts.providers === null ? null : isInUse(facts.providers[STORAGE_PROVIDER]);
  }
}

function detailOf(id: GuideStepId, facts: GuideFacts, done: boolean | null): string {
  if (done === null) return "This step could not be checked, because its saved facts did not load.";
  switch (id) {
    case "brand": {
      const count = facts.brandCount ?? 0;
      return count === 0
        ? "No brand yet. Start with its name and what you sell. The rest can wait."
        : `${count} ${count === 1 ? "brand is" : "brands are"} saved. Open one to fill in its brain.`;
    }
    case "engine": {
      const engine = facts.engine;
      if (!engine) return "The engine status did not load.";
      if (!engine.chosen) return "No engine is chosen for this workspace yet. Pick one below. TypeSafe JEV uses a TypeSafe key, and OpenAI Decisions uses an OpenAI key.";
      if (!engine.ready) return `${engine.label} is chosen, but it cannot answer yet. ${engine.reason}`;
      return `${engine.label} is chosen and ready. It receives every decision for this workspace.`;
    }
    case "sources": {
      const connected = SOURCE_PROVIDERS.filter((key) => isInUse(facts.providers?.[key])).length;
      return done
        ? `${connected} keyed ${connected === 1 ? "source is" : "sources are"} in use. Public pages and uploads are always available too.`
        : "No keyed source is connected. Public web pages and your uploads still work, so you can skip this for now.";
    }
    case "media":
      return done
        ? "Gemini reading and production keys are in use."
        : "Not connected. You can upload your own images and video instead, so skipping this is fine.";
    case "publish":
      return done
        ? "A paid-ad key is in use. Paid ads are created paused, and you switch them on in the platform. Regular posts depend on the accounts you connect on Connected accounts."
        : "Not set up. Regular posts need a Facebook Page, Instagram, YouTube or TikTok account. Paid ads need a Meta or TikTok key. Nothing is published until you choose a channel, and exports still work.";
    case "storage":
      return done
        ? "Google Drive is connected on the server."
        : "Not connected. Files stay on the server's disk until Drive is set up.";
  }
}

/**
 * The steps in their order, each with its status. Exactly one step can be current: the first required step that is not done and whose
 * status is known. A required step after it is todo, and every optional step that is not done is optional. An unknown step never becomes current.
 */
export function buildGuide(facts: GuideFacts): GuideStep[] {
  const dones = GUIDE_STEPS.map((definition) => doneOf(definition.id, facts));
  // The step to do now is the first required step that is not done. An optional step is never "Do this now": it waits until a person opens it.
  const currentIndex = dones.findIndex((done, index) => done === false && GUIDE_STEPS[index]?.required === true);
  return GUIDE_STEPS.map((definition, index) => {
    const done = dones[index];
    let status: GuideStepStatus;
    if (done === null) status = "unknown";
    else if (done) status = "done";
    else if (index === currentIndex) status = "current";
    else status = definition.required ? "todo" : "optional";
    return { ...definition, status, detail: detailOf(definition.id, facts, done) };
  });
}

/** The step to do now, or null when every step is done or unknown. */
export function currentStep(steps: readonly GuideStep[]): GuideStep | null {
  return steps.find((step) => step.status === "current") ?? null;
}

/** The counts and the one-line headline above the steps. It never says the setup is complete while a required step is open. */
export function guideSummary(steps: readonly GuideStep[]): { done: number; total: number; requiredDone: number; requiredTotal: number; headline: string } {
  const required = steps.filter((step) => step.required);
  const requiredDone = required.filter((step) => step.status === "done").length;
  const done = steps.filter((step) => step.status === "done").length;
  const next = currentStep(steps);
  const unknown = steps.some((step) => step.status === "unknown");
  const headline = requiredDone === required.length
    ? unknown
      ? "Every required step is done. Some optional steps could not be checked."
      : "Every required step is done. The optional steps can wait."
    : next
      ? `${requiredDone} of ${required.length} required steps are done. Next: ${next.title.toLowerCase()}.`
      : `${requiredDone} of ${required.length} required steps are done. Some steps could not be checked, so the next one is not known yet.`;
  return { done, total: steps.length, requiredDone, requiredTotal: required.length, headline };
}
