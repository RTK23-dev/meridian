import type { ObservedCreative } from "../domain.ts";
import { clusterBy, whitespaceAngles } from "../semantic/lexical.ts";

export function summarizeIntelligence(creatives: ObservedCreative[]): {
  whitespace: string[];
  angleClusters: { key: string; count: number }[];
  competitorCount: number;
  ownCount: number;
} {
  return {
    whitespace: whitespaceAngles(creatives),
    angleClusters: clusterBy(
      creatives.map((item) => ({ id: item.id, angle: item.angle })),
      "angle",
    ).map((group) => ({ key: group.key, count: group.ids.length })),
    competitorCount: creatives.filter((item) => item.origin === "competitor").length,
    ownCount: creatives.filter((item) => item.origin !== "competitor").length,
  };
}
