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
  /** What the step is, in plain words. */
  what: string;
  /** Why it matters to the person, in one sentence. */
  why: string;
  required: boolean;
  status: GuideStepStatus;
  /** A sentence about the step as it stands now. It states the saved fact or what is missing, never a live check. */
  detail: string;
};

/** Source connectors that take a key. Public web pages and uploads need none, so they are not in this list. */
export const KEYED_SOURCE_IDS = ["meta_ad_library", "youtube", "search", "twitter", "linkedin", "pinterest", "tiktok", "instagram", "licensed"] as const;

export function isInUse(state: ProviderState | undefined): boolean {
  return state === "usable" || state === "deployment_shared_default";
}

type Definition = Omit<GuideStep, "status" | "detail">;

export const GUIDE_STEPS: readonly Definition[] = [
  {
    id: "brand",
    title: "Create your first brand",
    what: "A brand is the business or product line that Meridian makes ads and posts for. Each brand keeps its own research, grades and creatives.",
    why: "Everything else belongs to a brand, so nothing can be graded or made until one exists.",
    required: true,
  },
  {
    id: "engine",
    title: "Choose a decision engine",
    what: "The engine answers the questions Meridian asks about each idea and ad: does it fit the brand, are its claims supported, is there risk. Pick TypeSafe JEV or OpenAI Decisions. Meridian never switches to the other one silently.",
    why: "No idea is graded without an engine, so nothing gets picked or made.",
    required: true,
  },
  {
    id: "sources",
    title: "Pick where examples come from",
    what: "Meridian learns from ads and posts that already work in your niche. Public web pages and your own uploads need no key. Ad libraries and video platforms need a key that you save on this page.",
    why: "Better examples give better grades. With no source at all, there is nothing to compare against.",
    required: false,
  },
  {
    id: "media",
    title: "Make images and video",
    what: "Gemini reads images and video frames and makes Omni video. Hypit runs as a separate process for video. You can also upload media you already have.",
    why: "Only needed when Meridian should produce media itself. Uploads cover the rest.",
    required: false,
  },
  {
    id: "publish",
    title: "Send work to Meta",
    what: "Meridian creates Meta ads as paused, so nothing spends until you switch them on in Meta Ads Manager. Organic posts go to the Facebook Page or YouTube account you connect on the Accounts screen.",
    why: "Only needed to publish. Until then, the export package holds everything Meridian made.",
    required: false,
  },
  {
    id: "storage",
    title: "Connect Google Drive",
    what: "Drive keeps the files Meridian makes: media, exports and reports. The server sets it up once, and every workspace on it shares it.",
    why: "Without Drive, files stay on the server's own disk.",
    required: false,
  },
];

const SOURCE_PROVIDERS = KEYED_SOURCE_IDS;
const MEDIA_PROVIDERS = ["perception", "production"] as const;
const PUBLISH_PROVIDER = "meta_graph";
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
      return facts.providers === null ? null : isInUse(facts.providers[PUBLISH_PROVIDER]);
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
        ? "The Meta Graph key is in use. New ads are created paused, and you switch them on yourself."
        : "Not connected. Nothing is published until you connect it. Exports still work.";
    case "storage":
      return done
        ? "Google Drive is connected on the server."
        : "Not connected. Files stay on the server's disk until Drive is set up.";
  }
}

/**
 * The steps in their order, each with its status. Exactly one step can be current: the first not-done step whose status is known.
 * A required step after it is todo, and an optional step after it is optional. An unknown step never becomes current.
 */
export function buildGuide(facts: GuideFacts): GuideStep[] {
  const dones = GUIDE_STEPS.map((definition) => doneOf(definition.id, facts));
  const currentIndex = dones.findIndex((done) => done === false);
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
