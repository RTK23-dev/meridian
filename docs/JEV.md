# JEV

JEV is the deterministic gate around evidence. It is not a prompt and it does not see pixels.

JEV Research is a separate upstream intelligence layer. It collects public Meta Ad Library video records, transcribes available audio, and stores typed, confidence-rated transcript analysis with source evidence. It discovers recurring patterns but makes no approval decision and does not claim that frequency predicts performance. Its patterns become evidence for the existing opportunity ranker and JEV decision questions; an approved decision can continue through the brief and Hypit handoff. A verified stored Hypit MP4 may then be uploaded to Meta and published only as a paused campaign chain after the tenant, approval, lineage, and artifact checks pass.

## Path

```
stored evidence
  → versioned question (id + schema version + evaluator)
  → probabilistic answer (yes, no, uncertain, insufficient, or violation)
  → calibration, only when an admin has approved a version
  → policy thresholds
  → AUTO_APPROVE | HUMAN_REVIEW | REJECT
  → jev_decisions row
```

Missing evidence and contradictory evidence stay in human review. A violation is a reject. Neither case can auto-approve. Calibration changes the next decision only. It does not rewrite a stored decision, and it does not move thresholds until an admin approves a proposal.

Code: `src/lib/meridian/jev/engine.ts`, `src/lib/meridian/jev/questions.ts`, `src/lib/meridian/jev/judgment.ts`, and `src/lib/meridian/jev/policy.ts`.

`decide()` clamps probability and confidence, then:

- probability ≥ autoApprove and confidence ≥ minConfidenceForAuto → AUTO_APPROVE
- else probability ≥ humanReview → HUMAN_REVIEW
- else REJECT

Low confidence cannot auto-approve. A strong-looking score with a thin brand record stays in review.

## Questions

| Id | What it reads | What it refuses to do |
| --- | --- | --- |
| claim_safety.v1 | Prohibited hits, unsupported claim hits, missing disclaimers | Grade prose |
| creative_qa.v1 | Claim evidence plus product presence, hook, CTA, avoided words | Look at an image |
| visual_qa.v1 | A vision description: logo, palette, product, claim, tone | Invent that description. `available: false` is HUMAN_REVIEW |
| brief_gate.v1 | Whether audience, product, hook, angle, CTA, and format are present | Write the brief |
| competitive_strength.v1 | Competitor counts and how often this angle appears versus the brand's own work | Invent a market when no rows are stored |
| brand_fit.v1 | Keyword overlap with the written brain, and whether the format is preferred | Treat a thin brain as a fit |
| historical_support.v1 | A learned CTR, CVR, or ROAS lift that already cleared the sample policy | Treat a missing pattern as positive evidence |
| risk_safety.v1 | Claim intensity, repeated aggressive rejections, negative lift | Approve a high-claim angle the brand keeps rejecting |
| opportunity_gate.v2 | The five component evaluations above. Probability is computed here | Accept a caller-supplied rank score. v1 did that and is retired |
| positioning_fit.v1 | Token overlap with written positioning | Score an empty positioning as a fit |
| reproducibility.v1 | Workflow coverage, protected-phrasing flag | Copy a competitor line |

Creative QA thresholds are 0.90 / 0.60 / 0.75. Opportunity thresholds are 0.88 / 0.28 / 0.72. A thin record stays in review. Risk evidence or protected phrasing caps probability under the reject line even if the other components look strong. Rank order is a separate weighted score. It is not the gate's probability.

## Persistence

Every decision stores the question version, answer schema version, model, provider, raw and calibrated probability, answer, evidence identifiers, policy version, calibration version, decision, and time. Reviewer outcomes are written beside the decision. They do not replace it.

Approved threshold versions are read on the next opportunity, brief, creative, image, and video judgment. Studio, opportunity refresh, and rerank use that loader. A proposal that has not been approved does not change a decision.

Research records are separate from `jev_decisions`: source ads, media hashes, transcript-cache entries, analysis runs and fields, transcript segments, and observed patterns live in the research tables. Analysis records identify provider, model, prompt/schema version, latency, token count, and representative analysis ids. Identical source/transcript/schema/model analyses are reused on retry. The source transcript is the only evidence the research analyst may classify; it may not infer visuals or outcomes. Transient job failures retry through the shared worker and eventually dead-letter; missing credentials and unavailable source media retain explicit statuses.

## Bayesian Learning Engine & Recency Decay

JEV's learning feedback loop updates Beta-binomial conjugate posteriors from observed performance:
- **Metrics Tracked**: Paid metrics (`ctr`, `cvr`, `roas`) and organic metrics (`retention_3s`, `completion_rate`, `shares`).
- **Recency-Decay Weighting**: Half-life time decay (`calculateDecayWeight`) discounts old observations, ensuring fresh signals drive the next brief without historical campaign bias.
- **Hierarchical Cold-Start Priors**: Translates anonymized vertical baselines (`hierarchicalColdStartPrior`) into empirical priors, accelerating learning for new brands while preserving strict tenant isolation.
- **FDR Filtering**: Uses Benjamini-Hochberg false-discovery rate control (`bhQValues`) to keep only statistically robust patterns.

## Tests

`src/lib/meridian/loop.test.ts`, `src/lib/meridian/learning/decay.test.ts`, and `evals/jev/cases.json` (loaded by `src/lib/meridian/jev/fixtures.test.ts`).
