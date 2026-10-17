import { winnerScore, type WinnerEvidence, type WinnerScore } from "../factory/winner-score.ts";
import { opportunityScore, DEFAULT_WEIGHTS, WEIGHT_KEYS, type ScoreInputs, type ScoreWeights } from "../scoring.ts";

export type GradingInput = {
  evidence?: Partial<WinnerEvidence>;
  scores?: Partial<ScoreInputs>;
  weights?: Partial<ScoreWeights>;
  creativeId?: string;
  niche?: string;
};

export type GradingResult = {
  engineId: string;
  overallScore: number;
  confidence: number;
  passed: boolean;
  components: Record<string, number>;
  reasons: string[];
};

export type GradingEngine = {
  id: string;
  name: string;
  description: string;
  grade(input: GradingInput): Promise<GradingResult>;
};

export function winnerScoreGradingEngine(): GradingEngine {
  return {
    id: "winner_score",
    name: "Winner Score Engine",
    description: "Evaluates public survival, iteration, spread, and advertiser quality signals.",
    async grade(input: GradingInput): Promise<GradingResult> {
      const evidence: WinnerEvidence = {
        daysRunning: input.evidence?.daysRunning ?? 0,
        // Unknown delivery, countries and platforms are unknown, not a count of zero.
        stillRunning: input.evidence?.stillRunning ?? null,
        iterationCount: input.evidence?.iterationCount ?? 0,
        countries: input.evidence?.countries ?? null,
        platforms: input.evidence?.platforms ?? null,
        advertiserSurvivorRate: input.evidence?.advertiserSurvivorRate ?? null,
        creativeQuality: input.evidence?.creativeQuality ?? null,
      };

      const result: WinnerScore = winnerScore(evidence);
      const passed = result.score >= 0.6;
      return {
        engineId: "winner_score",
        overallScore: result.score,
        confidence: Math.round(((result.high - result.low > 0 ? 1 - (result.high - result.low) : 0.8)) * 100) / 100,
        passed,
        components: result.components,
        reasons: result.evidence,
      };
    },
  };
}

export function heuristicGradingEngine(): GradingEngine {
  return {
    id: "heuristic",
    name: "Heuristic Brand-Fit Engine",
    description: "Evaluates brand fit, market signals, novelty, and risk using weighted rules.",
    async grade(input: GradingInput): Promise<GradingResult> {
      const missing = WEIGHT_KEYS.filter((key) => {
        const value = input.scores?.[key];
        return typeof value !== "number" || !Number.isFinite(value);
      });
      if (missing.length > 0) {
        return {
          engineId: "heuristic",
          overallScore: 0,
          confidence: 0,
          passed: false,
          components: {},
          reasons: [`Not scored. Missing ${missing.join(", ")}. A missing score is not filled with a default.`],
        };
      }
      const weights = { ...DEFAULT_WEIGHTS, ...input.weights };
      const scoreInputs: ScoreInputs = {
        brandFit: input.scores!.brandFit as number,
        historicalEvidence: input.scores!.historicalEvidence as number,
        marketSignal: input.scores!.marketSignal as number,
        novelty: input.scores!.novelty as number,
        reproducibility: input.scores!.reproducibility as number,
        saturation: input.scores!.saturation as number,
        risk: input.scores!.risk as number,
      };

      const result = opportunityScore(scoreInputs, weights);
      return {
        engineId: "heuristic",
        overallScore: result.normalized,
        confidence: 0.85,
        passed: result.normalized >= 0.55,
        components: { ...scoreInputs },
        reasons: [
          `Evaluated brand fit: ${scoreInputs.brandFit.toFixed(2)}`,
          `Historical evidence: ${scoreInputs.historicalEvidence.toFixed(2)}`,
          `Risk penalty: ${scoreInputs.risk.toFixed(2)}`,
        ],
      };
    },
  };
}

const customGradingEngines = new Map<string, GradingEngine>();

export function registerGradingEngine(engine: GradingEngine): void {
  customGradingEngines.set(engine.id, engine);
}

export function gradingEngineById(id: string): GradingEngine {
  if (customGradingEngines.has(id)) {
    return customGradingEngines.get(id)!;
  }
  if (id === "winner_score") return winnerScoreGradingEngine();
  if (id === "heuristic") return heuristicGradingEngine();
  throw new Error(`Unknown grading engine "${id}". Supported: winner_score, heuristic.`);
}
