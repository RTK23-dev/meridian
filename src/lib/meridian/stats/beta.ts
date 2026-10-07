/**
 * Beta-binomial helpers. Priors are Jeffreys (0.5, 0.5) unless a baseline
 * supplies a weakly informative prior. Nothing here is a causal certificate.
 */

export type BetaParams = { alpha: number; beta: number };

export type CredibleInterval = {
  low: number;
  high: number;
  mean: number;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function jeffreysPrior(): BetaParams {
  return { alpha: 0.5, beta: 0.5 };
}

/** Weakly informative prior centered on an observed baseline rate. */
export function baselinePrior(rate: number, strength = 8): BetaParams {
  const mean = clamp01(rate);
  const weight = Math.max(1, strength);
  return { alpha: mean * weight + 0.5, beta: (1 - mean) * weight + 0.5 };
}

export function updateBeta(prior: BetaParams, successes: number, trials: number): BetaParams {
  const safeSuccess = Math.max(0, successes);
  const safeTrials = Math.max(0, trials);
  const failures = Math.max(0, safeTrials - safeSuccess);
  return { alpha: prior.alpha + safeSuccess, beta: prior.beta + failures };
}

export function betaMean(params: BetaParams): number {
  const total = params.alpha + params.beta;
  if (total <= 0) return 0.5;
  return params.alpha / total;
}

export function betaVariance(params: BetaParams): number {
  const total = params.alpha + params.beta;
  if (total <= 0) return 0.25;
  return (params.alpha * params.beta) / (total * total * (total + 1));
}

/** Normal approximation of a Beta quantile. Fine for reporting, not for sampling. */
export function betaQuantile(params: BetaParams, p: number): number {
  const mean = betaMean(params);
  const sd = Math.sqrt(Math.max(1e-12, betaVariance(params)));
  const z = inverseNorm(clamp01(p));
  return clamp01(mean + z * sd);
}

export function betaInterval(params: BetaParams, level = 0.95): CredibleInterval {
  const tail = (1 - level) / 2;
  return {
    low: betaQuantile(params, tail),
    high: betaQuantile(params, 1 - tail),
    mean: betaMean(params),
  };
}

/**
 * P(bucket > baseline) for two independent Betas, via a normal approximation
 * of the difference. Deterministic. Returns 0.5 when both posteriors are the same.
 */
export function probabilityGreater(bucket: BetaParams, baseline: BetaParams): number {
  const mean = betaMean(bucket) - betaMean(baseline);
  const variance = betaVariance(bucket) + betaVariance(baseline);
  if (variance <= 1e-18) return mean > 0 ? 1 : mean < 0 ? 0 : 0.5;
  return 1 - normalCdf(0, mean, Math.sqrt(variance));
}

/** Benjamini-Hochberg q-values. Input order is preserved. */
export function bhQValues(pValues: number[]): number[] {
  const n = pValues.length;
  if (n === 0) return [];
  const ranked = pValues.map((value, index) => ({ value: clamp01(value), index })).sort((a, b) => a.value - b.value);
  const q = Array(n).fill(1);
  let min = 1;
  for (let rank = n; rank >= 1; rank -= 1) {
    const item = ranked[rank - 1];
    min = Math.min(min, (item.value * n) / rank);
    q[item.index] = Math.min(1, min);
  }
  return q;
}

function inverseNorm(p: number): number {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  const a = [ -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239 ];
  const b = [ -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1 ];
  const c = [ -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783 ];
  const d = [ 7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416 ];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number;
  let r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function normalCdf(x: number, mean: number, sd: number): number {
  const z = (x - mean) / (sd * Math.SQRT2);
  return 0.5 * (1 + erf(z));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-ax * ax);
  return sign * y;
}
