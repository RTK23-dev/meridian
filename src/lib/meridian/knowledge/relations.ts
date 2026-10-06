export type RelationEdge = {
  relation: "expresses_angle" | "uses_hook" | "uses_format" | "uses_proof" | "promotes_product";
  value: string;
};

export function relationshipEdges(creative: {
  angle: string;
  hookType: string;
  format: string;
  proofType: string;
  productName: string;
}): RelationEdge[] {
  const edges: RelationEdge[] = [];
  const push = (relation: RelationEdge["relation"], value: string) => {
    const trimmed = value.trim();
    if (trimmed) edges.push({ relation, value: trimmed.toLowerCase() });
  };
  push("expresses_angle", creative.angle);
  push("uses_hook", creative.hookType);
  push("uses_format", creative.format);
  push("uses_proof", creative.proofType);
  push("promotes_product", creative.productName);
  return edges;
}
