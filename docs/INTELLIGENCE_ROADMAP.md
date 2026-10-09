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
| Evidence | `evidence/types.ts` (OBSERVED / COMPUTED / INFERRED / LEARNED / VALIDATED), `evidence/bundle.ts`, research schema `jev.research-ad.v1` | Research fields carry `value`, `confidence`, `probability`, `evidence[]` with no observed-vs-inferred state |
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

- **P2a**: field-level epistemic state. Extend research fields with `state` (`OBSERVED`, `INFERRED`, `LEARNED`, `VALIDATED`), reusing the evidence state vocabulary. Migrate the research schema version. No change to existing scores.
- **P2b**: cheap ranking gate. Deterministic features (copy length, format, platform, recency, duplicate status) rank candidates before the multimodal scorer (`jev/multimodal-scorer.ts`) runs. Only the top N reach perception. The gate records why each candidate was skipped.
- **P2c**: hook, format, and pattern extraction carries evidence references for each extracted pattern. A pattern without evidence refs cannot be used by P3.

Exit: every pattern shown to a human or passed to JEV carries its evidence refs and state. Perception runs on fewer candidates, with the skip reasons stored.

## P3 — JEV decision engine

Goal: evidence becomes a structured creative decision, and that decision is the only authoritative input to `CreativePlan`.

Slices:

- **P3a**: plan lineage. `createPlan` requires a persisted decision id from the M2 gate and the evidence refs it used. A plan without lineage is refused.
- **P3b**: decision schema. Each decision records the question version, the evidence set it saw, its thresholds, and the reviewer decision. Re-running the same evidence with the same question version must produce the same decision record.
- **P3c**: `CreativePlan` as the single source of production truth. Production reads only the plan and its manifest (the source-of-truth test already checks this path; it must read the real path, not source text).

Exit: no plan, job, or creative exists without a decision and evidence lineage. The M2 gate covers every entry point.

## P4 — Production expansion

Only after P3 is complete.

Slices:

- **P4a**: provider capability and cost matrix from the registry. Selection chooses the cheapest provider that satisfies the plan's format, duration, aspect, and capability, and records the choice.
- **P4b**: carousel and mixed-media execution through the same durable job path as video.
- **P4c**: each new provider ships with a credential-gated live contract test and a fixture test. A provider is "connected" only after a real response (rule 1).

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
