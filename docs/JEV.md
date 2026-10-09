# JEV (TypeSafe Decisions API)

JEV is the deterministic epistemic gate around evidence. It executes typed semantic judgments using TypeSafe's native Decisions API served through the dedicated Dual JEV Provider Router (`src/lib/meridian/jev/router.ts`):
- **Routes Supported**:
  1. **Direct TypeSafe AI**: Official direct decisions endpoint (`TYPESAFE_JEV_BASE_URL/decisions`), requiring `TYPESAFE_JEV_API_KEY`. Returns `NOT_CONFIGURED` if unconfigured.
  2. **OpenRouter Decisions Route**: Uses OpenRouter's native Decisions API at `POST https://openrouter.ai/api/alpha/decisions` with model `typesafe/jev-1.13`.
- **Routing Modes**:
  - `AUTO` (default): Prefers configured route, falling back to alternate only on eligible transport/provider failure or when preferred is `NOT_CONFIGURED`.
  - `TYPESAFE_DIRECT`: Strictly executes against direct TypeSafe API without silent fallback.
  - `OPENROUTER`: Strictly executes against OpenRouter Decisions API.
  - `COMPARE`: Benchmark/development mode comparing outputs without silently merging them.
- **Supported Question Primitives**:
  - `choice`: One-of-N classification with probability distribution and confidence.
  - `noul`: Independent probabilistic judgment returning direct probability in `noul` (confidence is never fabricated).
  - `score`: Ordered discrete scoring with probability distribution, legend, and confidence.
- **Fail-Closed Policy**: If the remote Decisions API returns an error or is unreachable, the client abstains (`abstain_uncertain` or `provider_error`). It never falls back to generic chat models (`/chat/completions`) pretending to be JEV. Generic LLMs are synthesis tools for copy and brief writing, never substitutes for JEV.
- **State Minimization**: Only strictly required evidence fields, captions, transcripts, and controls are passed in the request state. Tokens, credentials, and unrelated tenant data are stripped.

JEV Research is a separate upstream intelligence layer. It collects public social media artifacts (Reels, TikTok, Shorts, Meta Ad Library), transcribes available audio, and stores typed, confidence-rated transcript analysis with source evidence. It discovers recurring patterns across organic and paid content but makes no approval decision and does not claim that frequency predicts performance. Its patterns become evidence for the existing opportunity ranker and JEV decision questions; an approved decision can continue through the brief and production router.

## Path

```
EvidenceBundle
  → state projection (minimized)
  → JevProviderRouter (TypeSafe Direct / OpenRouter)
  → typed answers (choice / noul / score)
  → provenance preservation (EvidenceRefs)
  → calibration & policy thresholds
  → AUTO_APPROVE | HUMAN_REVIEW | REJECT
  → persisted decision run & answers (decision ledger)
```

Missing evidence and contradictory evidence stay in human review. A violation is a reject. Neither case can auto-approve. Calibration changes the next decision only. It does not rewrite a stored decision, and it does not move thresholds until an admin approves a proposal.

Code: `src/lib/meridian/jev/router.ts`, `src/lib/meridian/jev/client.ts`, `src/lib/meridian/jev/engine.ts`, `src/lib/meridian/jev/questions.ts`, `src/lib/meridian/jev/judgment.ts`, and `src/lib/meridian/jev/policy.ts`.

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

### 1. Canonical CreativeStructure vs Optional Ad Narrative
Meridian models creative videos using canonical `CreativeStructure`:
- **Organic Content**: Preserves native creative formats (`pov`, `skit`, `storytime`, `listicle`, `tutorial`, `reaction`, `trend_audio`, `transformation`, `review`, `comparison`, `loop`, `organic_short`). Heuristic classifications are strictly marked `state: "INFERRED"` and `methodId: "creative_structure_classifier.v1"` with inspectable `heuristicScore`, never masquerading as calibrated confidence.
- **Paid Ads (AdNarrative)**: The legacy 6-beat ad narrative is an optional projection derived solely for direct-response paid ads:

| Beat | Window | Analytical Focus |
|---|---|---|
| **1. Hook** | `0 - 3s` | Visual contrast, facial expression, bold text overlay, pattern interrupt |
| **2. Problem** | `3 - 7s` | Pain point agitation, relatable dilemma, status-quo friction |
| **3. Reveal** | `7 - 15s` | Introduction of the product, paradigm shift, transformation |
| **4. Proof** | `15 - 25s` | Side-by-side demo, customer review, clinical data, social proof |
| **5. Offer** | `25 - 30s` | Value proposition, bundle discount, guarantee, scarcity |
| **6. CTA** | `30 - 35s` | Clear directional action (verbal cue + visual text sticker) |

### 2. Question-Aware Evidence Compression (`compressEvidenceForJev`)
To prevent token waste and focus JEV's attention, evidence bundles are compressed dynamically based on the specific question requested:
- `organic.visual_craft`: Includes scene detection, shot types, keyframes, and OCR text overlays.
- `organic.retention_architecture`: Includes scene cuts, pacing cadence, and timestamped transcripts.
- `organic.share_trigger`: Includes audience comments, intent categories, and creator baseline.
- `organic.transferability`: Includes creator and category comparative outlier context.
Every compressed fact retains structured `EvidenceRef` lineage pointing back to source media and offsets.

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

## Native TypeSafe JEV Decision Engine (v1.13)

JEV is built around TypeSafe's System One decision primitives:
- **`noul`**: Boolean necessity / compliance gates ($P \in [0, 1]$).
- **`choice`**: Selection across discrete categories with probability distributions.
- **`score`**: Ordered rubric evaluations across defined quality criteria.

### Structured Decision Flow
1. **Evidence Sufficiency Gate**: Questions declare strict `evidenceRequirements`. If required evidence is missing, the engine abstains (`abstain_insufficient_evidence`) with zero confidence and explicit reasons, rather than hallucinating answers.
2. **Deterministic Input Hashing**: Evaluates hash over tenant state, questions, and model parameters to power bounded in-memory caching.
3. **OpenRouter Gateway**: All JEV calls execute via OpenRouter (`JEV_PROVIDER=openrouter`, `JEV_MODEL=typesafe/jev-1.13`).
4. **Deterministic Policy Evaluator**:
   - `AUTO_APPROVE`: Average probability $\ge 0.85$ and minimum confidence $\ge 0.75$ with zero policy violations.
   - `HUMAN_REVIEW`: Any missing evidence, uncertainty, or average probability in $[0.50, 0.85)$.
   - `REJECT`: Any hard policy violation or low probability $< 0.50$.
5. **Dynamic Creative Structures**: Short-form videos use dynamic discovered segments (`CreativeStructure`), where narrative beats are an optional specialization rather than an enforced rigid structure.
6. **Calibration & Reliability**: Evaluated via Brier score, empirical log loss, and binned calibration curves before any seed prior is considered calibrated.

---

## Tests

- `src/lib/meridian/loop.test.ts`: End-to-end evidence, decision, and brief loop.
- `src/lib/meridian/jev/unified-engine.test.ts`: Native TypeSafe JEV engine tests (abstention, policy, Brier score, calibration).
- `src/lib/meridian/evidence/unified-evidence.test.ts`: Normalized evidence bundles, deduplication, and compression.
- `src/lib/meridian/production/unified-production.test.ts`: Production router, ManualCloud zero spend, and QC gates.
- `src/lib/meridian/learning/unified-learning.test.ts`: Learning guardrails, parameter lifecycle, and fatigue tracking.
- `src/lib/meridian/storage/unified-storage.test.ts`: Google Drive primary storage tests.
- `evals/jev/cases.json`: Ground-truth calibration test cases.

