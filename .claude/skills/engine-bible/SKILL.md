---
name: engine-bible
description: Shared scope for every Meridian video-engine agent. Verbatim Video Engine Bible sections 0 (how to use it, definition of done), 1 (scope, principles, locked decisions), 4 (data contracts), 5 (jobs, artifacts, gates) and 17 (repository layout, standards, testing). Load for any work under src/engine/.
---

# Video Engine Bible: shared core

The text below is copied verbatim from `docs/engine/VIDEO_ENGINE_BIBLE.md` (sections 0, 1, 4, 5 and 17). That file is the source; if the two ever differ, the file wins and this skill must be regenerated. Read the other sections in the file when your workstream lists them.

## 0. How to use this Bible

**This is the complete build specification for Meridian's video engine:** the system that takes a viral format, an example video, a rewritten script and visual requests, and produces a finished, post-ready 9:16 reel plus its variants, with no human step in the normal path. It is written for an agent swarm. Every agent should be able to pick a workstream from section 18, read the contracts it owns in section 4, and start building without asking anyone.

**What the engine is, in one sentence:** Claude makes every creative decision once per video, deterministic code does the editing from rules measured on the example, paid APIs make every pixel and sound, and hard gates refuse to render or deliver anything that fails a check.

**Reading order for every agent:**

1. Sections 0–3: purpose, rules and the shape of the system (15 minutes).
2. Section 4 in full: the data contracts are the interface between every workstream; they are law.
3. Section 5: how jobs, artifacts and gates move work between stages.
4. Section 18: pick your workstream; read only the sections it lists.
5. Section 19: the phase and acceptance tests your work must pass.

**Relationship to other documents.** This Bible covers the video engine only. The wider factory (discovery, rating, study, publishing, learning, the business) is in the [Meridian handoff](https://claude.ai/code/artifact/73d4edea-b38b-4c83-9b82-bf8c6ecc2a57), which also holds the codebase state and the working rules. Where the two overlap, this Bible wins for anything inside `src/engine/`.

**Conventions in this document:**

- **Must** means a hard requirement; a PR that breaks it is rejected. **Should** means the default unless the PR explains why not.
- Numbers marked **initial** (thresholds, weights, timings, costs) are starting values to be replaced by measurements. Code must read them from configuration, never hard-code them.
- Prices are list prices as researched in October 2026; the cost ledger replaces them in week one.

**Definition of done for any task:**

- [ ] Code merged on top of `main` with tests passing against real PostgreSQL.
- [ ] Contracts validated with zod at every boundary the task touches.
- [ ] Every paid call goes through the router, the credential resolver and the cost ledger.
- [ ] A **recorded live run** on real APIs, with artifact ids, costs and a rendered output or log attached to the PR.
- [ ] This Bible updated if the task changed a contract, a threshold or a decision.


## 1. Scope, principles and locked decisions

**In scope:** everything from a validated production request to delivered MP4s with a manifest: reference analysis, voice, scene planning, visual decisions, asset generation, take checks, editing, composition, rendering, review, variants and cost accounting.

**Out of scope (owned elsewhere):** finding and rating reels, writing scripts, publishing to Instagram, insights ingestion and nightly learning. The engine consumes a script; it never writes one from scratch. It emits learning data (section 16); it doesn't run the learning loop.

**Targets:**

| Target | Value |
| --- | --- |
| Output | 1080 × 1920, 30 fps, H.264, AAC, 15–60 s, loudness −14 LUFS |
| Master wall time | 6–12 min (initial) |
| Batch | 1,000 requests in a working day, 50+ videos in flight |
| Model cost | Average master about $2.70, variant about $0.32 (initial) |
| Quality | No video delivered that fails a gate; blind-test creator-grade rate tracked per format |
| Autonomy | No human step in the normal path; humans only see escalations and samples |

**Principles every workstream follows:**

1. **Claude decides, code executes.** Claude chooses what each beat shows and how it should feel. Code does timing, cutting, layering, loudness and safe zones, the same way every time.
2. **Voice is the clock.** The voice track is generated before the scene plan; every duration comes from word timings.
3. **Cheapest good-enough source per shot.** Code-rendered beats cost nothing; generation is used only where a face, motion or spectacle earns it.
4. **Copy genes, never content.** Structure, pacing, tone and edit grammar transfer; the example's footage, words, voice and music never enter a render.
5. **Typed artifacts, resumable stages.** Every stage writes one validated artifact; a failure resumes from the last good artifact.
6. **Fail closed.** Unknown values stay null; nothing is delivered that failed a gate; no fake success.
7. **Everything costs on the ledger.** Every paid call is estimated, reserved and reconciled.
8. **All compute is API.** No local models or renderers; ffmpeg runs only in stateless serverless functions.

**Locked decisions (don't reopen without new evidence):**

| # | Decision |
| --- | --- |
| L1 | Orchestration is Meridian's Postgres job queue in TypeScript, not a coding-agent session per video |
| L2 | Claude via the Anthropic API: Opus for direction, Sonnet for analysis and structured writing, Haiku for checks and volume |
| L3 | Pixels via OpenRouter (video, avatar, image, voice); stock via Pexels and Pixabay APIs |
| L4 | Render with HyperFrames on HeyGen's cloud render API; Remotion Lambda and Shotstack as fallbacks behind the same compiler |
| L5 | Our own clean-room contracts and code. Ideas from Hypit, OpenMontage and master-skills are reused; their code is not (Hypit's licence restricts multi-tenant use; OpenMontage is AGPL-3.0) |
| L6 | Claude never writes render code per video; it selects components and fills props |
| L7 | Every video carries a manifest; every decision is logged with its reason |
| L8 | Real product imagery for every product beat; text, prices and logos drawn by code only |


## 4. Data contracts

These types are the interface between every workstream. Implement each as a **zod schema** in `src/engine/contracts/` with exactly these field names, derive TypeScript types with `z.infer`, and version every schema (`schema` field). A change to a contract needs a version bump, a migration note in this section, and approval from the contracts owner (workstream W1).

Shared conventions: ids are prefixed ULIDs (`req_`, `dna_`, `shot_`, `take_`, `edl_`, `vid_`); times are milliseconds as integers; money is US dollars as numbers with 4 decimals; every artifact has `createdAt`, `contentHash` (sha256 of its canonical JSON or file bytes) and `parentIds`.

### 4.1 Input and analysis

```typescript
type ProductionRequest = {
  schema: 'meridian.production_request/v1';
  requestId: string;                      // req_...
  workspaceId: string;
  format: {
    formatId: string;                     // stable id shared by all requests copying one format
    referenceVideo: string;               // ig:reel/<id> or s3:// URI
    videoDnaId?: string;                  // if known; else analyze_reference runs
    keep: GeneId[];                       // e.g. 'hook_mechanism','pacing','caption_style'
    change: string[];                     // free labels: 'topic','presenter','products'
  };
  script: { language: string; beats: ScriptBeat[] };
  visualRequests: { beatId: string; want: string; strength: 'must' | 'may' }[];
  product?: { sku: string; productKitId: string; claimIds: string[] };
  page: { pageId: string; styleKitId: string; personaId?: string; voiceId: string; characterIds?: string[] };
  constraints: { aspect: '9:16'; maxMs: number; budgetUsd: number; deadline?: string; priority: 'rush' | 'normal' | 'batch' };
  output: { master: true; variants?: VariantMatrix };
};
type ScriptBeat = { beatId: string; role: BeatRole; text: string; emphasis?: string[] };
type BeatRole = 'hook' | 'setup' | 'item' | 'proof' | 'twist' | 'payoff' | 'cta';
type GeneId = 'hook_mechanism' | 'voice_persona' | 'emotional_arc' | 'structure' | 'proof_device' | 'edit_grammar' | 'conversion_move' | 'pacing' | 'caption_style';

type VideoDNA = {
  schema: 'meridian.video_dna/v1';
  videoDnaId: string; formatId: string; sourceRef: string; durationMs: number;
  transcript: { words: Word[] };          // from speech-to-text
  segments: DnaSegment[];
  genome: Partial<Record<GeneId, string>>; // named values from the Angle Bible
  editGrammar: EditGrammar;
  transferable: GeneId[]; notTransferable: string[];
  sourceDeletedAt?: string;               // must be set within 24 h
};
type Word = { wordId: string; text: string; startMs: number; endMs: number; confidence: number };
type DnaSegment = {
  segId: string; startMs: number; endMs: number; wordIds: string[];
  shotType: ReferenceShotType;            // what the example shows here
  layers: { base?: string; presenter?: string; broll?: string; graphics?: string; captions?: string };
  onScreenText?: string; beatRole?: BeatRole;
  motion: number; brightness: number; loudnessLufs: number; // from ffmpeg
};
type ReferenceShotType = 'talking_head' | 'broll_montage' | 'product_closeup' | 'onscreen_list' | 'sketch_joke' | 'spectacle' | 'screen_record' | 'react' | 'text_only' | 'other';
```

### 4.2 Edit grammar and voice

```typescript
type EditGrammar = {
  hookFirstCutMs: number; hookPayoffMs: number;
  shotLengthMs: { p25: number; p50: number; p75: number; curve: number[] }; // curve = median per tenth of the video
  rehookIntervalMs: number;
  captions: { wordsPerCaption: [number, number]; position: 'upper' | 'middle' | 'lower'; style: string; highlightCurrentWord: boolean };
  motion: { punchInsPer10s: number; punchInScale: number; shakeOnImpact: boolean; speedRamps: boolean };
  transitions: { kind: string; share: number }[];
  sound: { music: boolean; bpm?: number; energyCurve: number[]; sfxPer10s: number; silenceBeforePayoffMs?: number };
  endsOnLoop: boolean;
};

type VoiceTrack = {
  schema: 'meridian.voice_track/v1';
  voiceTrackId: string; requestId: string; voiceId: string; provider: string;
  audioUri: string; durationMs: number; lufs: number;
  words: Word[];                          // our script, timed
  beatSpans: { beatId: string; startMs: number; endMs: number }[];
};
```

### 4.3 Plan, shots and takes

```typescript
type VisualType = 'ugc_presenter' | 'product_hero' | 'stock_footage' | 'cinematic' | 'cartoon_rigged' | 'cartoon_generated' | 'coded_graphics' | 'react_clip' | 'kinetic_type' | 'stop_motion' | 'screen_mock';

type ScenePlan = {
  schema: 'meridian.scene_plan/v1';
  planId: string; requestId: string; videoDnaId: string; voiceTrackId: string;
  shots: ShotSpec[];
  estimatedUsd: number;
  decisions: Decision[];                  // every choice with alternatives and reason
};
type ShotSpec = {
  shotId: string; beatId: string; startMs: number; endMs: number;
  visualType: VisualType;
  layer: 'base' | 'cutaway' | 'presenter' | 'graphics';
  source:
    | { kind: 'generate'; modelClass: ModelClass; prompt: string; refs: string[]; firstFrame?: string; lastFrame?: string; takes: 1 | 2 }
    | { kind: 'component'; component: string; props: Record<string, unknown> }
    | { kind: 'stock'; query: string; minMs: number }
    | { kind: 'asset'; assetUri: string };
  mustSatisfy?: string;                   // the 'must' visual request text, if any
  downgradeTo?: VisualType;               // fallback type if takes fail
};
type ModelClass = 'video.cinematic' | 'video.budget' | 'video.i2v_pinned' | 'avatar' | 'image.keyframe' | 'image.edit' | 'tts' | 'lipsync';
type Decision = { at: string; chose: string; alternatives: { option: string; score: number }[]; reason: string; by: 'scorer' | 'director' | 'human' };

type Take = {
  schema: 'meridian.take/v1';
  takeId: string; shotId: string; attempt: number; provider: string; model: string;
  uri: string; durationMs: number; width: number; height: number;
  promptHash: string; costUsd: number; latencyMs: number;
};
type TakeVerdict = {
  takeId: string; pass: boolean; confidence: number;
  checks: { rule: string; pass: boolean; score?: number; detail?: string; atMs?: number }[];
  action: 'accept' | 'redo' | 'downgrade' | 'escalate';
};
```

### 4.4 Edit, render, review, delivery

```typescript
type EditDecisionList = {
  schema: 'meridian.edl/v1';
  edlId: string; requestId: string; variantOf?: string;
  durationMs: number; fps: 30; width: 1080; height: 1920;
  tracks: { layer: 'base' | 'cutaway' | 'presenter' | 'graphics' | 'captions' | 'stickers'; clips: EdlClip[] }[];
  audio: { voice: AudioClip; music?: AudioClip & { duckDb: number }; sfx: AudioClip[]; masterLufs: -14 };
  effects: { atMs: number; kind: 'punch_in' | 'shake' | 'speed_ramp' | 'flash'; params: Record<string, number> }[];
  seed: number;                           // for controlled variety
};
type EdlClip = { clipId: string; startMs: number; endMs: number; srcUri?: string; srcInMs?: number; component?: string; props?: Record<string, unknown>; transitionIn?: string; box?: { x: number; y: number; w: number; h: number } };
type AudioClip = { uri: string; startMs: number; endMs: number; gainDb: number };

type GateResult = { gate: GateId; subjectId: string; pass: boolean; checks: { rule: string; pass: boolean; value?: number; limit?: number; detail?: string }[]; failingShotIds?: string[] };
type GateId = 'request' | 'dna' | 'voice' | 'plan' | 'budget' | 'take' | 'edit' | 'pre_render' | 'render_integrity' | 'post_render';

type RenderedVideo = { videoId: string; edlId: string; uri: string; renderer: string; durationMs: number; bytes: number; costUsd: number; idempotencyKey: string };

type Manifest = {
  schema: 'meridian.manifest/v1';
  videoId: string; requestId: string; variantOf?: string;
  formatId: string; videoDnaId: string; genome: Partial<Record<GeneId, string>>;
  promptVersions: Record<string, string>;
  shots: { shotId: string; visualType: VisualType; takeId: string; provider: string; model: string; attempts: number }[];
  gates: GateResult[];
  decisions: Decision[];
  cost: { brain: number; generation: number; render: number; other: number; total: number };
  disclosures: { aiGeneratedPeople: boolean; paidPartnership: boolean };
  timings: Record<string, number>;        // ms per stage
};
type LedgerEntry = { entryId: string; requestId: string; stage: string; provider: string; model: string; estimateUsd: number; reservedUsd: number; actualUsd?: number; idempotencyKey: string; at: string };
```

**Variant matrix** (part of the request output):

```typescript
type VariantMatrix = {
  hooks?: number;                          // new hook lines
  products?: string[];                     // product SKUs to swap in
  personas?: string[]; languages?: string[];
  captionStyles?: string[]; music?: string[];
  maxVariants: number; budgetUsd: number;
};
```

### v1 additions (lead decisions, 2026-10-13)

Implemented in `src/engine/contracts/` as version 1. Nothing earlier exists, so there is no migration. These types are named in the Bible text or needed by it, but are not defined there. The lead approved them.

- `ArtifactEnvelope` (`envelope.ts`): `{ artifactId 'art_', type, schema, workspaceId, requestId, parentIds, contentHash, createdAt, body }`. Its `schema` must equal the body's `schema` literal.
- `AssetSpec`, `meridian.asset_spec/v1` (`assets.ts`): `{ specId 'asp_', shotId, modelClass, prompt, refs, firstFrame?, lastFrame?, durationMs, aspect '9:16', width 1080, height 1920, seed, takes 1 | 2 }`, with `assetCacheKey(spec, providerId)` as section 10.4 defines it.
- `ProviderAdapter` (the section 10.1 interface) and `ProviderError` (`assets.ts`).
- `ValidatedRequest`, `meridian.validated_request/v1`, and `IntakeRejection` (`request.ts`).
- `BudgetReservation`, `meridian.budget_reservation/v1` (`ledger.ts`). `reservedUsd` is the live hold. A paused reservation holds nothing and names its `pausedReason`. A released one shrinks to the amount committed.
- `LedgerEntry` (`ledger.ts`): the section 4.4 fields exactly, plus `actualIsEstimate?: boolean` for list-price fallbacks (section 14.1 step 4).
- `Composition`, `meridian.composition/v1` (`render.ts`). Its `contentHash` is the hash of its files, and it is the render idempotency key.
- `ReviewResult`, `meridian.review_result/v1` (`gate.ts`).
- Kits of section 13 (`kits.ts`).
- Id prefixes `art_`, `asp_`, `res_`, `cmp_`, `led_`.

Invariants added in v1 (the schemas enforce them):

- A `GateResult` or `TakeVerdict` passes only with at least one check and every check passing (section 12: unknown means fail).
- A `BudgetReservation.estimateUsd` equals the sum of its lines.
- Money carries at most four decimals.


## 5. Jobs, queue, artifacts and gates

Work moves between stages only through the queue, and only after a gate passes. A gate failure goes back no further than the failing piece: one shot, one layer, one render.

&#91;embedded content: how work moves between stages and through gates\]

### 5.1 Jobs

Every stage is a job row on Meridian's existing queue. New job types are registered in `engine/jobs/registry.ts`.

| Field | Meaning |
| --- | --- |
| `jobId`, `type`, `requestId` | Identity; `type` is a stage name from section 3 |
| `inputArtifactIds` | Artifacts the job reads; the job must not read anything else |
| `attempt`, `maxAttempts` | Infrastructure retries (network, 5xx, timeouts): default 3 with exponential backoff |
| `qualityAttempt` | Quality redos after a gate failure: max 2 per shot, then downgrade |
| `priority` | `rush` before `normal` before `batch` |
| `providerKey` | For produce jobs: the provider's concurrency bucket |
| `budgetReservationId` | Must exist before any paid call |

**States:** queued, leased, running, then succeeded or failed; failed jobs retry until `maxAttempts`, then go dead. A lease expires after the job type's timeout (initial: 2 min for Claude calls, 10 min for generation, 5 min for render); an expired lease returns the job to queued.

**Infrastructure retries vs quality redos.** A retry repeats the same call because something broke (no new money if the provider didn't charge). A redo is a new call because the output was bad: it costs money, carries the gate's failure hints into the new prompt, and counts against the shot's budget.

### 5.2 Artifacts

- Every artifact is a Postgres row (`engine_artifacts`: id, type, schema version, request id, parent ids, content hash, S3 URI, created at) plus, for media, an S3 object.
- S3 layout: `engine/{workspaceId}/{requestId}/{stage}/{artifactId}.{json|mp4|wav|png}`. Shared caches live under `engine/{workspaceId}/cache/{kind}/{contentHash}`.
- Artifacts are **immutable**. A redo writes a new artifact with the old one as a parent; nothing is overwritten.
- A request can be resumed from any stage by re-queuing that stage with the last good artifacts.
- Reference media is deleted within 24 hours of analysis; `VideoDNA.sourceDeletedAt` records when.

### 5.3 Gates

- A gate is a pure function `(artifact, context) => GateResult`, plus optional Claude calls for judgment checks. Gates live in `engine/review/gates/` and are listed in section 12.
- The orchestrator reads `GateResult`: a pass queues the next job; a fail routes by the rules in the diagram.
- **Redo** (max 2): the shot is regenerated with hints from the failed checks (for example "keep hands out of frame", "weight the hero image higher").
- **Downgrade:** after 2 failed redos, the shot's `downgradeTo` type is used (for example cinematic, then product hero, then coded product card). The planner updates the scene plan and logs a Decision.
- **Escalate:** if no downgrade exists, or the Critic's confidence is below the escalation threshold (initial 0.6), the request pauses and a review item is created with every take, its checks and the plan. A human picks, rejects or edits; the choice is stored as a gold-set label (section 16) and the request resumes.

### 5.4 Database tables (new)

`engine_requests`, `engine_artifacts`, `engine_jobs` (or the existing jobs table with engine types), `engine_gate_results`, `engine_decisions`, `engine_ledger` (or extended usage tables), `engine_manifests`, `engine_review_items`, `engine_kits` (style, persona, character, product), `engine_cache_index`. Every table carries `workspaceId` and is covered by tenancy checks.


## 17. Repository layout, standards and testing

### 17.1 Layout

```text
src/engine/
  contracts/          zod schemas for every type in section 4; index.ts exports all
  config/             thresholds.ts, weights.ts, prices.ts, budgets.ts (all versioned)
  jobs/               registry.ts, orchestrator.ts (advance, route failures), poller.ts
  intake/             validate.ts, cacheLookup.ts
  analyze/            reference.ts, segmenter.ts (Claude), genome.ts (Claude)
  edit/               grammar.ts, editor.ts, rules.ts
  voice/              voice.ts, timings.ts
  plan/               align.ts, visual.ts (5 steps), prompts.ts, director.ts
  assets/             router.ts, cache.ts, normalise.ts, providers/<vendor>.ts
  claude/             client.ts (caching, batch, structured output), roles/<role>.ts
  prompts/            <role>@<n>.md
  compose/            compiler.ts, styleKit.ts, components/<name>/
  render/             hyperframesCloud.ts, remotionLambda.ts, shotstack.ts
  review/             gates/<gate>.ts, critic.ts, slideshowRisk.ts, sampling.ts
  variants/           expand.ts, diff.ts
  budget/             estimate.ts, reserve.ts, reconcile.ts
  media/              ffmpeg function clients: probe, cuts, frames, loudness, flicker, ocr
  events/             emit.ts
  test/fixtures/      reference reels (owned or licensed), scripts, kits, recorded API responses
functions/ffmpeg/     serverless ffmpeg handlers
migrations/           engine_* tables
```

### 17.2 Standards

1. TypeScript strict mode; no `any` across module boundaries; every boundary validated with zod.
2. Pure functions for editor, scorer, gates and compiler; side effects only in job handlers and adapters.
3. All configuration through `engine/config`; no magic numbers in logic.
4. Every external call through the router or the Claude client, with an idempotency key and a ledger entry.
5. Errors are typed (`EngineError` with kind, retryable, stage); no swallowed exceptions; no success return on failure.
6. Logs are structured; secrets and personal data never logged.
7. Every new module ships with tests and a short README stating which section of this Bible it implements.

### 17.3 Testing pyramid

| Level | What | Where | Runs |
| --- | --- | --- | --- |
| Unit | Editor, scorer, budget fitter, gates, grammar maths, compiler | Next to code | Every commit |
| Contract | zod round-trips; schema versions; fixture artifacts parse | `contracts/` | Every commit |
| Recorded adapters | Each provider adapter against recorded responses (success, rate limit, timeout, policy refusal) | `assets/providers/` | Every commit |
| Components | Golden-frame renders of every component fixture with HyperFrames locally; pixel diff under 1% | `compose/components/` | Every commit |
| Integration | Full pipeline on fixtures with recorded APIs and real PostgreSQL | `test/` | Every commit |
| Live smoke | One master per visual type on real APIs, budget capped at $10 | Nightly | Nightly and before release |
| End-to-end | 3 reference reels × 3 scripts × 2 pages with real APIs; manifests and costs checked | Phase gates | Each phase |

**CI must block** on unit, contract, adapter, component and integration failures. Live smoke failures page the owner but don't block merges.


