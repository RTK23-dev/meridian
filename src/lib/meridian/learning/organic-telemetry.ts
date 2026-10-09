/**
 * Organic Telemetry & Hierarchical Learning Flywheel
 * 
 * Closes the feedback loop using first-party organic performance:
 * 1. Evaluates 3s hold rate, completion, save rate, and share rate against account medians
 * 2. Thompson sampling allocation across proven winners vs exploration formulas (20%)
 * 3. Detects formula fatigue: triggers retirement when posterior decays over 2 consecutive evaluation windows
 */

export interface OrganicPostPerformance {
  postId: string;
  formulaCardId: string;
  niche: string;
  publishedAt: string;
  views: number;
  threeSecondHoldRate: number; // 0.0 to 1.0 (e.g. 0.65)
  completionRate: number;       // 0.0 to 1.0 (e.g. 0.28)
  sharesPerK: number;           // shares per 1,000 views
  savesPerK: number;            // saves per 1,000 views
  followersGained: number;
  beatsAccountMedian: boolean;
}

export interface FormulaPosteriorState {
  formulaCardId: string;
  niche: string;
  alpha: number; // successes (beat median)
  beta: number;  // failures (below median)
  expectedWinProbability: number;
  sampleCount: number;
  consecutiveDecliningWindows: number;
  status: "active" | "fatigued_retired" | "exploring";
}

export class OrganicLearningFlywheel {
  /**
   * Updates Bayesian posterior for a formula using new published performance.
   */
  static updatePosterior(
    prior: FormulaPosteriorState,
    performance: OrganicPostPerformance
  ): FormulaPosteriorState {
    const isWin = performance.beatsAccountMedian;
    const newAlpha = prior.alpha + (isWin ? 1 : 0);
    const newBeta = prior.beta + (isWin ? 0 : 1);
    const total = newAlpha + newBeta;
    const newWinProb = Number((newAlpha / total).toFixed(3));

    // Check performance trend vs previous expected probability
    const isDeclining = newWinProb < prior.expectedWinProbability;
    const decliningWindows = isDeclining ? prior.consecutiveDecliningWindows + 1 : 0;
    const isFatigued = decliningWindows >= 2 && total >= 8;

    return {
      formulaCardId: prior.formulaCardId,
      niche: prior.niche,
      alpha: newAlpha,
      beta: newBeta,
      expectedWinProbability: newWinProb,
      sampleCount: prior.sampleCount + 1,
      consecutiveDecliningWindows: decliningWindows,
      status: isFatigued ? "fatigued_retired" : prior.sampleCount < 5 ? "exploring" : "active",
    };
  }

  /**
   * Selects formulas to produce using Thompson sampling with an exploration floor.
   */
  static selectFormulasForProduction(
    candidates: FormulaPosteriorState[],
    options?: { explorationShare?: number; batchSize?: number }
  ): FormulaPosteriorState[] {
    const explorationShare = options?.explorationShare ?? 0.2;
    const batchSize = options?.batchSize ?? 3;
    const activeCandidates = candidates.filter((c) => c.status !== "fatigued_retired");

    if (activeCandidates.length === 0) return [];

    // Thompson sampling: draw Beta(alpha, beta) sample for each candidate
    const sampled = activeCandidates.map((c) => {
      // Approximation of Beta draw using mean + variance noise
      const mean = c.alpha / (c.alpha + c.beta);
      const variance = (c.alpha * c.beta) / (Math.pow(c.alpha + c.beta, 2) * (c.alpha + c.beta + 1));
      const draw = Math.max(0, Math.min(1, mean + (Math.random() - 0.5) * Math.sqrt(variance) * 2));
      return { candidate: c, score: draw };
    });

    // Sort descending by sample score
    sampled.sort((a, b) => b.score - a.score);

    // Ensure exploration: if exploration candidates exist, reserve 20% of slots
    const exploringPool = activeCandidates.filter((c) => c.status === "exploring");
    const selected: FormulaPosteriorState[] = [];

    const exploreCount = Math.round(batchSize * explorationShare);
    if (exploreCount > 0 && exploringPool.length > 0) {
      selected.push(exploringPool[0]);
    }

    for (const item of sampled) {
      if (selected.length >= batchSize) break;
      if (!selected.some((s) => s.formulaCardId === item.candidate.formulaCardId)) {
        selected.push(item.candidate);
      }
    }

    return selected;
  }
}
