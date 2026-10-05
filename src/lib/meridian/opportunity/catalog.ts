/** Strategy hypotheses. These are not market facts and must not be shown as such. */
export type Hypothesis = {
  id: string;
  label: string;
  angle: string;
  hookType: string;
  format: string;
  proofType: string;
  claimIntensity: number;
  keywords: string[];
  hookLine: string;
};

export const HYPOTHESES: Hypothesis[] = [
  {
    id: "demonstration",
    label: "Demonstration-led problem/solution",
    angle: "demonstration",
    hookType: "problem",
    format: "short_ugc",
    proofType: "demonstration",
    claimIntensity: 0.2,
    keywords: ["show", "demo", "problem", "solve", "before"],
    hookLine: "Open on the problem, then show the product doing the job in one take.",
  },
  {
    id: "curiosity",
    label: "Curiosity hook",
    angle: "curiosity",
    hookType: "curiosity",
    format: "short_ugc",
    proofType: "product_in_use",
    claimIntensity: 0.25,
    keywords: ["secret", "curious", "unexpected", "mystery", "wait"],
    hookLine: "Open with one specific question the product can actually answer.",
  },
  {
    id: "testimonial",
    label: "Customer testimonial",
    angle: "testimonial",
    hookType: "social_proof",
    format: "testimonial",
    proofType: "testimonial",
    claimIntensity: 0.35,
    keywords: ["customer", "review", "story", "trust", "testimonial"],
    hookLine: "Open with a customer situation, not a slogan. Use only allowed claims.",
  },
  {
    id: "offer",
    label: "Offer-led",
    angle: "offer",
    hookType: "offer",
    format: "static",
    proofType: "offer",
    claimIntensity: 0.55,
    keywords: ["discount", "offer", "deal", "save", "price"],
    hookLine: "State the real offer. Do not invent a discount, guarantee, or deadline.",
  },
  {
    id: "comparison",
    label: "Comparison",
    angle: "comparison",
    hookType: "contrast",
    format: "short_ugc",
    proofType: "comparison",
    claimIntensity: 0.7,
    keywords: ["versus", "compare", "instead", "alternative", "switch"],
    hookLine: "Compare on a job the product actually does. Do not name a competitor unless the brief says to.",
  },
  {
    id: "objection",
    label: "Objection handling",
    angle: "objection",
    hookType: "objection",
    format: "short_ugc",
    proofType: "explanation",
    claimIntensity: 0.3,
    keywords: ["worry", "skeptic", "objection", "hesitate", "but"],
    hookLine: "Name one objection from the brand record, then answer it without a new claim.",
  },
];

export function hypothesisById(id: string): Hypothesis | undefined {
  return HYPOTHESES.find((item) => item.id === id);
}
