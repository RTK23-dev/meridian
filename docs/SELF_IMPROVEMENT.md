# Self-improvement

The system is self-improving only where this path actually runs:

1. A creative is stored with angle, hook type, format, and the other attributes.
2. A person records performance against that creative. The source column is `manual`. Nothing is imputed.
3. Recompute patterns. `learnPatterns` sums observations, computes brand-baseline CTR, and emits a pattern only when a bucket has at least 3 creatives, 300 impressions, and absolute lift of at least 5%.
4. The pattern row is stored on the brand.
5. The next opportunity refresh reads it. Positive lift raises historical evidence for that angle or hook. Negative lift raises risk.
6. The next brief copies the pattern summary into `learningNotes` and into the generation context.
7. Generation, when a model is configured, receives that context. A human-written script is still checked by the guardian.

`src/lib/meridian/loop.test.ts` stores four curiosity creatives and four offer creatives. Curiosity CTR is higher. Before learning, the offer-shaped hypothesis ranks above curiosity because the sample brand talks about price and deals. After learning, curiosity ranks above offer, and the curiosity brief contains the computed pattern. The lift is not hard-coded.

Rejections are the other write-back. A rejected creative stores a reason code. The next rank penalizes high-claim angles after repeated unsupported or prohibited rejections.

What this is not: the app does not rewrite its own source, move JEV thresholds, or publish a winner.
