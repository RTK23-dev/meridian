export type WorkflowStage = {
  key: string;
  label: string;
  instruction: string;
};

export type CreativeWorkflow = {
  templateId: string;
  templateVersion: string;
  label: string;
  stages: WorkflowStage[];
  variables: Record<string, string>;
};

export type WorkflowTemplate = {
  id: string;
  version: string;
  label: string;
  angles: string[];
  stages: WorkflowStage[];
  variableKeys: string[];
};

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "ugc_demo",
    version: "v1",
    label: "UGC demonstration",
    angles: ["demonstration", "curiosity", "objection"],
    variableKeys: ["host", "product", "language", "hook", "offer", "cta", "visualTreatment", "broll", "script"],
    stages: [
      { key: "hook", label: "Hook", instruction: "First line is the problem or question. Do not open on the logo." },
      { key: "demo", label: "Demonstration", instruction: "Show the product doing the job. Do not add a result that is not an allowed claim." },
      { key: "proof", label: "Proof", instruction: "Use only allowed claims. Include required disclaimers in the spoken or written line." },
      { key: "offer", label: "Offer", instruction: "Repeat the offer exactly. Do not invent a discount." },
      { key: "cta", label: "Call to action", instruction: "Ask for one action." },
    ],
  },
  {
    id: "testimonial",
    version: "v1",
    label: "Testimonial",
    angles: ["testimonial"],
    variableKeys: ["host", "product", "language", "hook", "offer", "cta", "visualTreatment", "script"],
    stages: [
      { key: "hook", label: "Situation", instruction: "The speaker names a situation, not a superlative." },
      { key: "proof", label: "Experience", instruction: "Stay inside allowed claims. No before/after numbers unless the brief includes them." },
      { key: "cta", label: "Call to action", instruction: "One next step." },
    ],
  },
  {
    id: "offer_card",
    version: "v1",
    label: "Offer card",
    angles: ["offer", "comparison"],
    variableKeys: ["product", "language", "hook", "offer", "cta", "visualTreatment", "script"],
    stages: [
      { key: "hook", label: "Headline", instruction: "The offer is the headline. No urgency that the brief did not specify." },
      { key: "proof", label: "Qualifier", instruction: "Add the required disclaimer if one exists." },
      { key: "cta", label: "Call to action", instruction: "One action." },
    ],
  },
];

export function templateForAngle(angle: string): WorkflowTemplate {
  return WORKFLOW_TEMPLATES.find((template) => template.angles.includes(angle)) ?? WORKFLOW_TEMPLATES[0]!;
}

export function instantiateWorkflow(templateId: string, variables: Record<string, string>): CreativeWorkflow {
  const template = WORKFLOW_TEMPLATES.find((item) => item.id === templateId) ?? WORKFLOW_TEMPLATES[0]!;
  const filled: Record<string, string> = {};
  for (const key of template.variableKeys) filled[key] = variables[key]?.trim() ?? "";
  return {
    templateId: template.id,
    templateVersion: template.version,
    label: template.label,
    stages: template.stages.map((stage) => ({ ...stage })),
    variables: filled,
  };
}

export function templateCoverage(workflow: CreativeWorkflow): number {
  const keys = Object.keys(workflow.variables);
  if (keys.length === 0) return 0;
  const filled = keys.filter((key) => workflow.variables[key]?.trim()).length;
  return filled / keys.length;
}
