# Intelligence Roadmap (P1–P5)

Status: planned at `main` 10a579e (beta.9). Each phase ships as one or more draft PRs. A PR merges after CI is green. Nothing here changes scoring, JEV scoring, or auth unless the phase says so.

Rules that bind every phase (from AGENTS.md and the audit):

- Never invent data, metrics, publish receipts, or connected states. Missing evidence is review, not a pass.
- Scores are scores until a calibration report says otherwise. No phase claims lift or accuracy without measured data.
- Fail closed on missing lineage: no decision, evidence, or budget without a recorded link.
- Tests run on the real database and real service code. Only external boundaries (network, provider APIs) are stubbed.

## Ground truth at beta.9

| Area | Exists | Verified gap |
|---|---|---|
| Discovery | Durable frontier, leases, run outcomes (D4 fixed) | Source rows are keyed by run-scoped item ids |
| Dedupe | `evidence/dedupe.ts` (canonical URL, platform id, perceptual hash, embeddings) | `normalizeCanonicalUrl` drops every query parameter except tracking ones, so distinct products collapse; `http`/`https` and `www` are not reconciled |
| Evidence | `evidence/types.ts` (OBSERVED / COMPUTED / INFERRED / LEARNED / VALIDATED), `evidence/bundle.ts`, research schema `jev.research-ad.v1` | Transcript segments are checked against the supplied input (text and timestamps), so observation integrity holds. Field labels, claims, and confidences carried no state, so a consumer could not tell an observation from a model inference |
| Opportunities | `opportunity/` (candidates, catalog, posterior, rerank) | Ranking runs after research; no cheap pre-perception filter |
| JEV | `jev/engine`, `evaluateJevGate`, `loadGatedJevDecision` (M2 fail-closed) | Creative judgments are not yet the only input to `CreativePlan` |
| Creative | `creative/engine`, `CreativePlan` state machine (CAS transitions) | Plan lineage to evidence refs is recorded, not enforced |
| Production | Durable jobs, materialization, per-job reservations (D1–D3) | Providers: Omni, Veo, Higgsfield, Hypit, manual cloud; carousel and mixed-media execution incomplete |
| Telemetry | `unified_performance_telemetry` (migrations 0024, 0027), `performance_observations` | Creative-level outcome linkage from publish to telemetry is not end to end |

## P1 — Discovery intelligence

Goal: every discovered item has one canonical source identity per brand, the same page found in two runs is one source, and every observation traces to the run and seed that produced it.

Slices:

- **P1a (this PR)**: canonical URL normalization and brand-scoped source identity.
  - `normalizeCanonicalUrl` keeps query parameters, removes tracking parameters and fragments, sorts the rest, normalizes `http` to `https` and drops default ports, and keeps `www.` distinct.
  - Discovery upserts `sources` keyed by `brandId | canonicalKey` when the item's canonical URL is an http(s) URL. Non-URL items keep the run-scoped id, so unrelated niche results cannot merge.
  - Exit: the same URL discovered in two runs yields one source row for the brand; the same URL in two brands in one organization yields two rows; distinct products on one path yield distinct rows.
- **P1b**: structured page evidence. The crawler already extracts JSON-LD, meta tags, and Open Graph. Persist them as `OBSERVED` evidence attached to the discovered item, with the fetch time and final URL.
- **P1c**: provenance links. A `source_observations` table links each source to every run and item that observed it, so the source row no longer carries the only history.

Decisions taken:

- Conservative dedupe. A false merge loses evidence and cannot be undone without a split job. A false split only duplicates a row that a later merge can fold together. We prefer splits.
- `www.` stays distinct. Two hosts can serve different sites.
- Paths keep their case. Path case is meaningful on many sites.

## P2 — Creative intelligence

Goal: identify hooks, formats, and patterns from evidence, keep observation separate from inference, link every claim to its evidence, and rank cheaply before any expensive perception runs.

Slices:

- **P2a** (done): epistemic state. Schema `jev.research-ad.v2`. Transcript segments are `OBSERVED`. Field labels and claims are `INFERRED`. Each field's confidence is labelled `confidenceSource: model_self_report`, so it is not presented as calibrated. The validator sets these states, so a model cannot relabel its own inference. Existing v1 cached analyses are not reused, so each ad is analyzed once more.
- **P2b** (done): cheap ranking gate. `research/gate.ts` scores each ad from metadata before any media download, transcription, or analysis. Duplicates are skipped and the best `RESEARCH_GATE_MAX_ADS` (default 20) are admitted. Every decision is stored with its score and reason, and skipped ads are `gate_skipped`. Weights are `seed_prior`, not calibrated. Previously first-come first-served until the byte budget ran out. Planned as deterministic features ranking candidates before the expensive steps.
- **P2c** (done): research patterns are `INFERRED`, not `OBSERVED`. A pattern counts the model's labels, which are inferences, so the old label was wrong. Each pattern stores `evidence_refs` (up to five example ads, each with the transcript segment ids behind its label), and its confidence is labelled `model_self_report`. Labels with no citation are not counted. Organization summaries store no examples, so no brand's transcript crosses a brand boundary. Migration `0041` relabels stored `OBSERVED` patterns and opportunity research states. Not done: the opportunity engine still lists only ad and analysis ids, not segment ids, and the scoring gate on `pattern.confidence` (`opportunity/candidates.ts`) still relies on model self-reports (see Open questions).

Exit: every pattern shown to a human or passed to JEV carries its evidence refs and state. Perception runs on fewer candidates, with the skip reasons stored.

## P3 — JEV decision engine

Goal: evidence becomes a structured creative decision, and that decision is the only authoritative input to `CreativePlan`.

Slices:

- **P3a** (done): plan lineage. `createPlan` requires `lineage` (the persisted decision id and the evidence refs it cited). A plan without a decision id is refused. A plan that produces deliverables with no cited evidence is refused; an abstained plan may cite none. Production takes lineage from the gated decision (`loadGatedJevDecision`), not from brief text. The `creative_plans.decision_id` column is enforced by a BEFORE INSERT trigger (migration `0042`), not a CHECK constraint, so legacy plans stay updatable. Not done: legacy plans whose brief has no decision keep a null `decision_id` and no recorded evidence refs, so they are not fully traced. Their count needs an owner's decision (they can be left, or retired).
- **P3b** (done): decision record identity. Each `jev_decisions` row carries `decision_fingerprint` (question and version, provider, model, schema, policy, calibration, thresholds, input judged, and the evidence as a set; not the subject or the decision time) and `outcome_digest` (decision, probabilities, confidence, reasons, answer, evidence state). Re-running the same evidence under the same question version must reproduce the outcome: `assertReproducible` refuses a rerun whose outcome differs under the same fingerprint. Migration `0043` adds the columns. Not done: rows written before 0043 keep empty fingerprints and are not reproducibility-checked. The `insertDecision` helper in `machine-shared.ts` has no callers, so it writes no fingerprint; it should be removed or wired before any new writer uses it. Only the creative writer has a database-level reproducibility test. The brief, opportunity, and publish writers record the fields, but they are verified only by typecheck and the shared record functions. The brief writer records `reviewer_decision = 'approve'` at creation, so a human approval is recorded without a separate review step; that needs an owner's decision.
- **P3c** (done for the video materializer and the approved-plan executor): production runs on the plan. `CreativePlan.productionContext` is a snapshot of the brief taken when the plan is made (title, audience, angle, product name, opportunity id). The executor reads the plan row for its status, brand, decision, and brief reference, and gates on the plan's recorded decision. Materialization reads the plan row for title, lineage, owner (its approver), and opportunity link. A brief edited after planning, including during an in-flight render, no longer changes what production produces. A plan with no snapshot is refused, and so is a plan whose recorded decision is gone, even when its brief still has one. No migration: the snapshot lives in `plan_payload`. Not done: the executor still reads brand data (products and creatives) for semantic and fact checks, and it still sets the brief's status to `used` by id. Both are bookkeeping and brand data, not plan semantics, but a strict reading of P3c would move them too. The existing `creative-plan-is-source-of-truth.test.ts` does not read a brief at all, so it does not check the path. The P3c tests do. Plans made before this change have no snapshot and cannot be executed; they must be re-planned.

Exit: no plan, job, or creative exists without a decision and evidence lineage. The M2 gate covers every entry point.

## P4 — Production expansion

Only after P3 is complete.

Slices:

- **P4a** (done for the video deliverable path): provider and model are chosen from a capability matrix. `production/capability-matrix.ts` takes each registered model, its task, duration, and aspect ratio, and its provider's cost per second. A candidate is refused with reasons when its model is unusable or deprecated, or it does not support the task, the duration, or the aspect ratio, or it is a zero-spend workflow. The cheapest eligible candidate is chosen under LOWEST_COST, and the first in the mode's order under BALANCED and QUALITY_FIRST. `ProductionRouter.selectForSpec` returns the provider and the full selection, and the executor records it in the durable job input (`providerSelection`) with the estimate. An explicitly requested provider that cannot produce the deliverable is refused, not substituted. Deprecated and zero-spend candidates are selected only when named explicitly. Behaviour change: BALANCED used to send any 'auto' video to google_omni regardless of aspect or duration, so a 4:5 or 45-second deliverable reached a provider that does not offer it. It now goes to an eligible provider or is refused. A typical 8-second 9:16 video still goes to google_omni. Not done: the default cost mode is still BALANCED. Under LOWEST_COST the same 8-second video would go to hypit at an estimated $0.40, against $1.20 for google_omni, so making it the default is an owner decision with a quality trade-off. Costs are the providers' declared estimates, not live prices, and no live contract run backs them; that is P4c. `routeTheoretical` and `rankProviders` still use the old ranking and are used only by two tests.
- **P4b** (in progress): durable multi-modal production. One lifecycle for video, image, and carousel, with audio and mixed media extensible. Split into four PRs.
  - **P4b-1** (done): modality and price model. `CreativeSpec.modality` is explicit (`video`, `image`, `carousel`, `audio`, `mixed_media`), and only video is routed so far. The matrix takes a modality and its billed units. Each candidate is priced from a `PriceQuote` in one of four states: `verified`, `configured`, `unknown`, or `stale`. Only a verified or configured price, in the billed unit, with an amount, yields an estimate. An unknown or stale price is refused unless `allowUnknownCost` is set, and LOWEST_COST ranks known prices first. Only the explicit provider path allows unknown prices. The only prices Meridian holds are each video provider's declared per-second estimate, recorded as `configured`, not verified. No image price is declared, so every image price is `unknown`. The executor refuses a video whose cost is unknown before any job row or provider call exists. Not done: the default cost mode is still BALANCED.
  - **P4b-2** (done): durable image jobs. Every image deliverable is a `production_jobs` row (`modality = image`, migration `0044`) written before the provider is called, and its budget reservation is held before that call. Image providers sit behind the same matrix as video: an explicit provider that cannot make the aspect is refused before any call. A provider with no declared image price is `unknown`, so an unpriced image reserves an equal share of the plan's explicit spend cap and settles at that ceiling, with the estimator recorded as `unpriced-ceiling-v1`. A plan with an unpriced image and no cap is refused before any job or call. Outcomes: a call that is provably not made (no credentials) releases its reservation; a returned failure or a thrown call is ambiguous and holds its reservation for reconciliation; a stored artifact is verified by its magic bytes and its SHA-256, and the job is `COMPLETED`. Materialization re-reads the stored bytes, refuses bytes that do not match the recorded checksum, and reads only the job's immutable snapshot and its plan. The poller dispatches completion by modality, and it never resubmits an interrupted image. Image bytes are stored in Google Drive, the same artifact path as video; `asset_blobs` is no longer written for images. Behaviour changes: images now need Drive to be configured, and a 4:5 image is refused for Google's image model, which does not offer 4:5. The plan cost model no longer invents a per-image price: unpriced image steps carry `null`, and the total counts only known amounts. In the testing runtime only, an in-memory artifact store and a 1x1 PNG test double stand in for Drive and the provider. Not done: carousel parent and child lineage (P4b-3).
  - **P4b-3** (done): carousel as an ordered artifact set. A carousel is one parent job (`modality = carousel`, migration `0044`) whose slides are its child image jobs (`parent_job_id`, `sequence_index`). The parent holds no reservation: each slide reserves and settles its own share once. The parent completes only when every slide is materialized. A failed slide makes it incomplete, and a carousel that stops before its slides exist is incomplete too. A run with an unresolved slide stays pending. An incomplete carousel creates no carousel creative; the slides that completed keep their own creatives. A complete carousel creates one creative that lists its slides by `sequence_index`, not by when they completed. Its status is `rejected` if any slide was rejected and `in_review` otherwise. It is judged by its slides, not separately. The poller claims carousel parents and settles them from their slides. Found and fixed while testing: a failed slide decided the carousel before its later slides existed, so the record did not match the slides that completed. Not done: a carousel's slides are still generated one at a time, and a failed slide stops the run, as it does for every image. Completed slides from that run are kept, but the run is not resumed.
  - **P4b-4** (done): QC across modalities and lineage reconstruction. QC is a creative's review status read as a verdict: `approved` is PASS, `in_review` is REVIEW, `rejected` is REJECT, and anything else is PENDING, so a missing check is never a pass. A carousel is judged by its slides: any rejected slide rejects it, a pending slide keeps it pending, and otherwise its own status decides. The verdict is read from the status when needed, never copied, so it cannot drift from the review queue. `reconstructCreativeLineage` follows a creative back through its production job, its carousel parent, its plan, and its JEV decision, and lists every link it cannot find in `missing`. A lineage with a missing link is not complete, and nothing is inferred to fill the gap, so a legacy creative with no recorded job reports itself as incomplete. Not done: audio and mixed-media production are not routed, so they have no QC path yet.
- **P4c** (code done, live runs not done): each provider ships with a fixture test and a credential-gated live contract test. The Google image provider (`google_nano_banana`) has both: its fixture tests in `nano-banana.test.ts` cover the documented response shapes and error payloads, and `nano-banana.live.test.ts` makes one real request and checks the returned bytes by their own magic number. The Omni video provider already had a credential-gated live test. A provider is "connected" only after a real response (rule 1). Health follows the rule. Hypit reports `HEALTHY` only after its `/health` endpoint answers, and manual cloud only after Drive reports healthy. The Google image provider reports `CONFIGURED` from credential presence alone, with no probe, so it is not verified until its live test passes. Not done: nothing has been run against a live service, and the Hypit, Veo, and Higgsfield live tests are not written.

Exit: every deliverable records provider, model, estimate, reservation, and artifact. No provider is listed as available without a live contract run.

## P5 — Measurement and learning

Goal: close the loop from publish to ranking and JEV, with calibration before any score is trusted.

Slices:

- **P5a**: creative-level linkage. A stored creative links to its production job, its publish record, and its telemetry rows. Publish and test receipts come only from provider responses.
- **P5b**: outcome ingestion through the existing performance normalizer, with decay on recency (`TELEMETRY_FLYWHEEL.md`).
- **P5c**: feedback into ranking (P2b) and into JEV priors. Priors change only after a calibration report shows the change improves prediction on held-out outcomes.

Exit: a calibration report exists before any learned weight is used by JEV. Until then, learned values are displayed as `LEARNED` with their sample size.

## PR sequence

1. P1a — canonical identity (this PR)
2. P1b — structured page evidence
3. P1c — provenance links
4. P2a — field epistemic state
5. P2b — cheap ranking gate
6. P2c — evidence-linked patterns
7. P3a–c — decision lineage and plan authority
8. P4a–c — provider matrix, carousel and mixed media, live contract tests
9. P5a–c — linkage, ingestion, calibrated feedback

Each PR: draft, real-database tests, a red check against the previous behavior for every bug it claims to fix, and a PR body that lists what is not verified.

## Open questions

- Which provider comes first in P4b (carousel rendering or a second video provider)? This changes the order of P4 slices.
- Is a calibration sample size of 200 held-out outcomes per decision class acceptable before P5c changes JEV priors? A smaller threshold weakens the guarantee.
- The opportunity gate (`opportunity/candidates.ts`: a pattern needs `sampleCount >= 2` and `confidence >= 0.65`) reads the model's self-reported confidence. It is a scoring gate, so P2c leaves it unchanged. Should P3 replace it with a calibrated score, or keep the self-report threshold until P5 calibration exists?
- Is the default gate cap of 20 ads per run (`RESEARCH_GATE_MAX_ADS`) the right operational limit? It changes how many ads reach transcription and analysis, so it needs an owner's decision.
- Shared-database test isolation (found in P4b-1). The poller claimed production jobs database-wide, so a test's count could include another test's leftover rows. Resolved in P4b-3: `pollProductionJobs` takes an optional organization scope, and the suites that count claims scope their polls to their own tenant. The full serial PostgreSQL suite passes on a fresh database. Not done: the budget suites share the database without a scope; they pass in the serial run.
