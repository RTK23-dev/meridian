export type PromptAsset = {
  id: string;
  version: string;
  purpose: string;
  model: string;
  temperature: number;
  status: "active" | "retired";
  inputSchema: string;
  outputSchema: string;
};

export const PROMPTS: PromptAsset[] = [
  {
    id: "creative_script",
    version: "v1",
    purpose: "Draft a structured ad script from a brief and retrieved brand knowledge.",
    model: "grok-4.5",
    temperature: 0.4,
    status: "active",
    inputSchema: "{ brief, context }",
    outputSchema: "{ hook, script, offer, cta, visualTreatment, claims: string[] }",
  },
  {
    id: "brain_suggest",
    version: "v1",
    purpose: "Propose brand-brain edits from untrusted page text. A person must accept each field.",
    model: "grok-4.5",
    temperature: 0.2,
    status: "active",
    inputSchema: "{ excerpt, fields }",
    outputSchema: "{ suggestions: { field: string, value: string }[] }",
  },
  {
    id: "visual_evidence",
    version: "v1",
    purpose: "Describe an advertisement image as structured evidence. The gate, not the model, decides.",
    model: "grok-4.5",
    temperature: 0,
    status: "active",
    inputSchema: "{ imageUrl, productName, allowedClaims, prohibitedClaims }",
    outputSchema: "{ logo_present, logo_match_probability, palette_match, product_match, claim_detected, claim_supported, tone_fit }",
  },
];

export function promptById(id: string): PromptAsset | undefined {
  return PROMPTS.find((prompt) => prompt.id === id && prompt.status === "active");
}
