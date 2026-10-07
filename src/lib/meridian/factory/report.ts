import type { ConceptTrend } from "./trends.ts";
import type { WinnerScore } from "./winner-score.ts";

export type StrategistReport = {
  week: string;
  won: { label: string; why: string }[];
  ride: { concept: string; evidence: string[] }[];
  drop: { concept: string; evidence: string[] }[];
  queuedTemplates: string[];
  note: string;
};

export function weeklyStrategistReport(input: {
  week: string;
  winners: { label: string; score: WinnerScore }[];
  trends: ConceptTrend[];
  queuedTemplates: string[];
}): StrategistReport {
  const won = input.winners
    .filter((item) => item.score.score >= 0.55)
    .map((item) => ({
      label: item.label,
      why: item.score.evidence.join(", "),
    }));
  const ride = input.trends
    .filter((item) => item.momentum === "rising")
    .map((item) => ({ concept: item.concept, evidence: item.evidence }));
  const drop = input.trends
    .filter((item) => item.momentum === "fading")
    .map((item) => ({ concept: item.concept, evidence: item.evidence }));
  return {
    week: input.week,
    won,
    ride,
    drop,
    queuedTemplates: input.queuedTemplates.filter(Boolean),
    note: "This report uses stored ads, scores, and trends only. Missing evidence stays missing.",
  };
}
