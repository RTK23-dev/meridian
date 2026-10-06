export type ExperimentDesign = {
  hypothesis: string;
  successMetric: "ctr";
  secondaryMetric: "cvr";
  expectedLearning: string;
  audience: string;
};

/** A testable statement. It does not predict the result. */
export function designExperiment(input: { angle: string; productName: string; audience: string }): ExperimentDesign {
  const angle = input.angle.trim() || "unspecified";
  const product = input.productName.trim() || "the recorded product";
  const audience = input.audience.trim() || "the recorded audience";
  return {
    hypothesis: `Whether a ${angle} angle increases CTR for ${product} among ${audience} versus this brand's own baseline.`,
    successMetric: "ctr",
    secondaryMetric: "cvr",
    expectedLearning: `Whether ${angle} is transferable to ${product} for ${audience}. A pattern is stored only after the sample policy is met.`,
    audience,
  };
}
