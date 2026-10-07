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

---

## Account-Level Intelligence & Multimodal DNA Engine

Introduced in migration `0022_jev_account_intelligence.sql` (`src/lib/meridian/jev/account-engine.ts` and `src/lib/meridian/jev/multimodal-scorer.ts`), JEV expands from isolated variant evaluation into comprehensive account-level intelligence and portfolio analysis.

### 1. 6-Beat Short-Form Narrative Decomposition
Every video creative is decomposed into a structured 6-beat narrative arc:

| Beat | Window | Analytical Focus |
|---|---|---|
| **1. Hook** | `0 - 3s` | Visual contrast, facial expression, bold text overlay, pattern interrupt |
| **2. Problem** | `3 - 7s` | Pain point agitation, relatable dilemma, status-quo friction |
| **3. Reveal** | `7 - 15s` | Introduction of the product, paradigm shift, transformation |
| **4. Proof** | `15 - 25s` | Side-by-side demo, customer review, clinical data, social proof |
| **5. Offer** | `25 - 30s` | Value proposition, bundle discount, guarantee, scarcity |
| **6. CTA** | `30 - 35s` | Clear directional action (verbal cue + visual text sticker) |

### 2. Decile Trait Separation
JEV categorizes an account's content portfolio into top decile (top 10%) vs. bottom decile (bottom 10%) by blended engagement and retention, calculating exact creative differentiators:
- **Speech Rate (WPM)**: Pacing distribution across narrative beats.
- **Audio Energy**: Dynamic range and RMS energy across hook vs. body.
- **Motion Intensity**: Frame-to-frame pixel change rate in the first 3 seconds.
- **Text Density**: On-screen typography density and legibility.
- **Visual Style**: UGC selfie vs. high-production vs. screencast vs. illustration.

### 3. Multimodal Predictive Scoring (`multimodal-scorer.ts`)
- **Logistic Hook Retention Prediction**: Predicts probability of 3s hook retention using calibrated weights:
  $$P(\text{retention}) = \frac{1}{1 + \exp(-(\beta_0 + 0.35 \cdot \text{visual} + 0.25 \cdot \text{audio} + 0.20 \cdot \text{motion} + 0.20 \cdot \text{text}))}$$
- **Audio Prosody Scoring**: Analyzes speaking pace (140-180 WPM sweet spot) and dynamic audio energy.
- **Comment Objection Mining**: Extracts recurring audience objections (e.g., price, shipping, efficacy) to proactively address in upcoming briefs.

### 4. Competitor Whitespace Radar (`jev_whitespace_opportunities`)
Analyzes competitor ad coverage to identify **un-saturated creative angles**:
- Calculates competitor saturation scores per category.
- Formulates high-expected-win-probability whitespace opportunities.
- Allows operators to promote whitespace directly into new Studio briefs.

### 5. Intelligence Dashboard
Located at `/brands/$brandId/intelligence`:
- **Account DNA Tab**: High-level archetype, posting cadence, top decile vs. bottom decile comparative cards, and 6-beat narrative timeline.
- **Competitor Whitespace Tab**: Filterable opportunities table with win probability, competitor saturation ratings, and action controls (`Promote to Brief`, `Dismiss`).
- **Semantic Memory Tab**: Chronological feed of analyzed content pieces, narrative breakdowns, and objection clusters.

---

## Tests

- `src/lib/meridian/loop.test.ts`: End-to-end evidence, decision, and brief loop.
- `src/lib/meridian/jev/account.test.ts`: 12 comprehensive unit and integration tests for Account DNA, 6-beat scoring, decile separation, and whitespace detection (< 1.5s on 500-post dataset).
- `src/lib/meridian/learning/decay.test.ts`: Recency decay math, weighted beta updating, and cold-start priors.
- `evals/jev/cases.json`: Ground-truth calibration test cases.

