import { winnerScore, type WinnerEvidence, type WinnerScore } from "../factory/winner-score.ts";
import { opportunityScore, DEFAULT_WEIGHTS, type ScoreInputs, type ScoreWeights } from "../scoring.ts";

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
        stillRunning: input.evidence?.stillRunning ?? false,
        iterationCount: input.evidence?.iterationCount ?? 0,
        countries: input.evidence?.countries ?? 1,
        platforms: input.evidence?.platforms ?? 1,
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
      const weights = { ...DEFAULT_WEIGHTS, ...input.weights };
      const scoreInputs: ScoreInputs = {
        brandFit: input.scores?.brandFit ?? 0.5,
        historicalEvidence: input.scores?.historicalEvidence ?? 0.5,
        marketSignal: input.scores?.marketSignal ?? 0.5,
        novelty: input.scores?.novelty ?? 0.5,
        reproducibility: input.scores?.reproducibility ?? 0.5,
        saturation: input.scores?.saturation ?? 0.2,
        risk: input.scores?.risk ?? 0.2,
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
