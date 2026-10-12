import { BRAIN_FIELDS, REQUIRED_BRAIN_KEYS, brainFieldLabel, type BrainKey, type BrainSectionId } from "../../lib/meridian/brain.ts";

/**
 * What to write in each brain field, and an example shown as placeholder text. The example is never saved: it disappears
 * as soon as the person types, and no field is filled from it. Examples are illustrative. They name the kind of answer
 * wanted, not a fact about any brand, so nothing here is a claim the brand has made.
 */
export const FIELD_GUIDE: Record<BrainKey, { help: string; example: string }> = {
  mission: { help: "Why the brand exists, in one or two sentences.", example: "For example: to make everyday bathing gentle enough for a newborn." },
  objectives: { help: "What the brand is working toward. A measurable goal helps the brief.", example: "For example: more repeat purchases from existing customers." },
  positioning: { help: "How the brand is different, and for whom. Opportunities and briefs build on this.", example: "For example: a fragrance-free wash for families who want a gentle product at a shop price." },
  differentiators: { help: "What the brand does that alternatives do not. Name only what you can show.", example: "For example: every batch is tested before it leaves the site." },
  valueProposition: { help: "The one benefit a customer gets, in the customer's own words.", example: "For example: skin that stays calm after every bath." },
  proofPoints: { help: "Facts you can back up: a certificate, a study, a review count. Only what you can prove.", example: "For example: a certificate with its issuer and the year it was issued." },
  offers: { help: "Current offers that may be advertised, with their terms. Remove offers that have ended.", example: "For example: a starter set at a stated price, valid until a stated date." },
  targetCustomers: { help: "Who buys, in their situation. Name an age, a role or a need, not just a category.", example: "For example: parents of a child under three who buy their own bath products." },
  personas: { help: "Two or three typical people. Give each a situation and what they care about.", example: "For example: a first-time parent who reads every ingredient list." },
  problems: { help: "The problems customers try to solve, in their own words.", example: "For example: \"My toddler's skin goes red after every bath.\"" },
  desires: { help: "What customers want to feel or achieve after they buy.", example: "For example: a bath routine that takes no thought at all." },
  objections: { help: "Why people hesitate, and the answer to each doubt.", example: "For example: \"It costs more than the supermarket brand.\"" },
  tone: { help: "The feeling every line should carry. Three to five words.", example: "For example: warm, calm, plain-spoken, never clinical." },
  personality: { help: "How the brand would act if it were a person.", example: "For example: a patient friend who knows the subject well." },
  writingStyle: { help: "Sentence length, point of view and formatting for copy.", example: "For example: short sentences, written to \"you\", no exclamation marks." },
  wordsToUse: { help: "Words and phrases the brand uses. Separate them with commas.", example: "For example: gentle, everyday, fragrance-free." },
  wordsToAvoid: { help: "Words the brand never uses, including jargon and competitor names.", example: "For example: miracle, cure, guaranteed." },
  requiredDisclaimers: { help: "Text that must appear with a claim or product, word for word.", example: "For example: \"Do a patch test before first use.\"" },
  prohibitedClaims: { help: "Claims the brand must never make. The brief gate blocks any brief that matches one.", example: "For example: cures, clinically proven, works in a week." },
  requiredClaims: { help: "Claims to make when they are relevant and supported. Copy them as legal wrote them.", example: "For example: the approved wording of a claim, with its conditions." },
  preferredFormats: { help: "The formats that suit the brand: image, video, carousel or text.", example: "For example: a short vertical video, then a product image." },
  preferredChannels: { help: "Where the brand posts or advertises, most important first.", example: "For example: Instagram Reels first, then the Facebook feed." },
  colors: { help: "Brand colours, with their hex codes if you have them.", example: "For example: #8f6232 for the accent, #f6f4ee for the background." },
  typography: { help: "The typefaces and what each one is used for.", example: "For example: a serif for headlines, a sans-serif for body text." },
  imageryRules: { help: "What images should show and how they are lit, framed or styled.", example: "For example: natural light, real rooms, no retouched skin." },
  forbiddenImagery: { help: "Images the brand never uses.", example: "For example: before-and-after skin photos, crying babies." },
};

/** The page anchor for a field. The setup steps link here, so a person lands on the field they must fill. */
export function brainFieldAnchor(key: BrainKey): string {
  return `brain-field-${key}`;
}

function filled(value: string | undefined): boolean {
  return (value ?? "").trim().length > 0;
}

export type BrainSetupStep = {
  key: BrainKey;
  label: string;
  section: BrainSectionId;
  anchor: string;
  done: boolean;
  /** Done steps are done. The first open step is current. Later open steps wait their turn. */
  state: "done" | "current" | "upcoming";
};

/**
 * The four required fields in the order the form shows them, each with whether it has content. Whitespace counts as empty.
 * The first open step is the one to do next. A brain with every required field filled has no current step.
 */
export function brainSetupSteps(values: Partial<Record<BrainKey, string>>): BrainSetupStep[] {
  const steps = REQUIRED_BRAIN_KEYS.map((key) => {
    const field = BRAIN_FIELDS.find((item) => item.key === key);
    return {
      key,
      label: brainFieldLabel(key) ?? key,
      section: field?.section ?? "identity",
      anchor: brainFieldAnchor(key),
      done: filled(values[key]),
    };
  });
  const firstOpen = steps.findIndex((step) => !step.done);
  return steps.map((step, index) => ({
    ...step,
    state: step.done ? "done" : index === firstOpen ? "current" : "upcoming",
  }));
}

/** The required field to fill next, or null when all four have content. */
export function nextBrainStep(values: Partial<Record<BrainKey, string>>): BrainSetupStep | null {
  return brainSetupSteps(values).find((step) => step.state === "current") ?? null;
}
