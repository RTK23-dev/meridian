# JEV

JEV is the deterministic gate around evidence. It is not a prompt and it does not see pixels.

## Path

```
text or vision description
  → structured evidence
  → typed question (id + version + evaluator)
  → probability and confidence
  → thresholds
  → AUTO_APPROVE | HUMAN_REVIEW | REJECT
  → jev_decisions row
  → review queue or rejection row, when required
```

Code: `src/lib/meridian/jev/engine.ts` and `src/lib/meridian/jev/questions.ts`.

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

Every decision stores input, evidence, question version, probability, confidence, thresholds, reasons, optional provider and model response, reviewer id, reviewer decision, note, time, brand, and correlation id.

Reviewer outcomes are written back onto the same row. They do not yet move the thresholds. That would be calibration, and it is not implied by the column existing.

## Tests

`src/lib/meridian/loop.test.ts` and `evals/jev/cases.json` (loaded by `src/lib/meridian/jev/fixtures.test.ts`).
