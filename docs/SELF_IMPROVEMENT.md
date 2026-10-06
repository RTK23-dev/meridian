# Self-improvement

The system is self-improving only where this path actually runs:

1. A creative is stored with angle, hook type, format, and the other attributes.
2. A person records performance against that creative. The source column is `manual`. Nothing is imputed.
3. Recompute patterns. `learnPatterns` sums observations, computes brand-baseline CTR, conversion rate, and ROAS, and emits a pattern only when a bucket has at least 3 creatives, 300 impressions, and absolute lift of at least 5%. The same floor applies to pairs: angle+hook, angle+format, hook+format, and product+angle.
4. Each stored pattern has a state. OBSERVED meets the floor but is thin. INFERRED has at least 800 impressions. VALIDATED has at least 4 creatives, 2000 impressions, and 15% absolute lift. VALIDATED is not a causal certificate. OBSERVED patterns move the next score less than VALIDATED ones.
5. The pattern row is stored on the brand, including the state. Another brand's pattern is refused.
6. Recording performance inserts a `learning.update` job. Recompute marks queued jobs for that brand succeeded. Nothing runs them on a timer.
7. The next opportunity refresh reads the pattern. Positive lift raises historical evidence for that angle, hook, or pair. Negative lift raises risk.
8. The next brief copies matching pattern summaries, including pairs, into `learningNotes` and into the generation context.

`src/lib/meridian/acceptance.test.ts` is the cycle check. It loads competitor rows from `evals/acceptance/market.json`, discovers `unboxing` only because those rows exist, ranks offer above curiosity before any performance, then stores curiosity performance and checks that curiosity outranks offer and that the next brief contains both the angle pattern and the angle+hook pair. A copied hook line is rejected. Missing vision evidence stays in human review. A calibration report is computed and does not change thresholds.

What this is not: the app does not rewrite its own source, move JEV thresholds, publish a winner, or call a neural embedding model.
