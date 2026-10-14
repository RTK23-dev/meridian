# The Video Engine Bible

Oct 12, 2026 · @Victor

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
| L2 | Claude via OpenRouter by default, through the engine's one API gateway (owner decision 2026-10-14, replacing "via the Anthropic API"): Opus for direction, Sonnet for analysis and structured writing, Haiku for checks and volume. The route table can move any role to the Anthropic API directly or to another provider |
| L3 | Pixels via OpenRouter (video, avatar, image, voice), through the same gateway; stock via Pexels and Pixabay APIs |
| L4 | Render with HyperFrames on HeyGen's cloud render API; Remotion Lambda and Shotstack as fallbacks behind the same compiler |
| L5 | Our own clean-room contracts and code. Ideas from Hypit, OpenMontage and master-skills are reused; their code is not (Hypit's licence restricts multi-tenant use; OpenMontage is AGPL-3.0) |
| L6 | Claude never writes render code per video; it selects components and fills props |
| L7 | Every video carries a manifest; every decision is logged with its reason |
| L8 | Real product imagery for every product beat; text, prices and logos drawn by code only |

## 2. System architecture

The engine is a set of stateless workers inside Meridian that pull jobs from the Postgres queue, call external APIs, and write artifacts. All state lives in Postgres and S3, so any worker can resume any job.

&#91;embedded content: system architecture\]

| Component | Responsibility | Built on |
| --- | --- | --- |
| Orchestrator | Creates the stage jobs for each request, advances on gate pass, routes failures | Meridian job queue (`SKIP LOCKED`, leases, retries, dead-letter) |
| Router | Picks a provider per asset request by weighted score; enforces concurrency per provider | Extends Meridian's cost-mode router and rate limiter |
| Credential resolver | One key set per workspace; no key in logs | Meridian, from PR #39 |
| Cost ledger | Estimate, reserve, reconcile per call | Meridian usage tables, extended |
| API gateway | The one way to the network: route table (capability to provider and model, OpenRouter by default), credentials from the resolver, API-key and OAuth auth, ledger on every paid call | New (`engine/gateway/`, `engine/config/routes.ts`) |
| Claude adapter | Structured output through the API gateway, versioned prompts; prompt caching and Batch API where the route supports them (20.3 item 6) | New |
| Pixel adapters | One interface, many providers: OpenRouter video, avatar, image, TTS; stock APIs; lip-sync, background removal, upscaling APIs | New |
| Media functions | Serverless ffmpeg (probe, cut detection, frame sampling, loudness, motion and flicker metrics), speech-to-text, embeddings | New, scale to zero |
| Compiler and render adapters | Edit decision list to HyperFrames composition; render via cloud; fallbacks | New `VideoEngine` implementations |
| Gates | Every check in section 12 | Extends `gates.ts` and `runEngineGate` |
| Review inbox | Human escalations and samples | Meridian UI (#45) |
| Artifact store | Content-addressed S3 objects plus Postgres metadata | Meridian S3 + new tables (section 5) |

**Trust boundaries.** External API outputs are untrusted data: validate type, size, duration and codec before storing. Text returned by models never becomes an instruction to another stage; it is parsed into typed fields or rejected. Reference videos are deleted after analysis; only derived Video DNA is kept.

## 3. The pipeline at a glance

Fourteen stages, grouped into the eight steps drawn below. Each stage is one job type, reads typed artifacts, writes one artifact, and passes a gate before the next job is queued. Full specifications are in section 6.

&#91;embedded content: the pipeline, eight groups of stages\]

| # | Stage (job type) | Group | Reads | Writes | Gate |
| --- | --- | --- | --- | --- | --- |
| 1 | `intake` | 1 | ProductionRequest | ValidatedRequest | Request validity |
| 2 | `analyze_reference` | 2 | Reference video | VideoDNA with EditGrammar | DNA completeness |
| 3 | `voice` | 2 | Script, voice kit | VoiceTrack with WordTimings | Length and clarity |
| 4 | `plan` | 3 | VideoDNA, VoiceTrack, request, kits | ScenePlan | Plan validity |
| 5 | `estimate_reserve` | 3 | ScenePlan | BudgetReservation | Budget |
| 6 | `produce_shot` (one per shot) | 4 | ShotSpec | Take | none |
| 7 | `check_take` (one per take) | 4 | Take, kits | TakeVerdict | Take check |
| 8 | `edit` | 5 | ScenePlan, chosen takes, WordTimings, EditGrammar | EditDecisionList | Edit rules |
| 9 | `compose` | 6 | EditDecisionList, kits | Composition | Schema |
| 10 | `pre_render_gate` | 6 | Composition, EDL | GateResult | Pre-render gate |
| 11 | `render` | 6 | Composition | RenderedVideo | Render integrity |
| 12 | `post_render_review` | 7 | RenderedVideo, EDL | ReviewResult | Post-render review |
| 13 | `variants` | 8 | Master EDL, variant matrix | Variant EDLs, then stages 9 to 12 each | Same gates |
| 14 | `deliver` | 8 | All of the above | Manifest and reconciled cost | none |

**Parallelism:** stages 2 and 3 run in parallel (analysis is cached per format). Stage 6 fans out to one job per shot; stage 7 to one per take. Each variant fans out to its own stages 9 to 12. Everything else is sequential per request.

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

### v2 changes and migration (E2, contract version `engine-contracts@2`)

Approved by the lead, 2026-10-14. The set version is `CONTRACTS_VERSION` in `src/engine/contracts/version.ts`. Every change
is additive, so nothing written under v1 becomes invalid. Types with a `schema` literal are unchanged, so their literals
stay `/v1`. `LedgerEntry` and `VoiceKit` have no literal, so the set version carries their bump.

- **`LedgerEntry` (4.4, `ledger.ts`):** two optional fields trace a Claude call to its role. `role` is one of the ten Claude
  roles of 11.1 (`segmenter`, `genome`, `request_classifier`, `planner`, `director_check`, `tightener`, `critic_take`,
  `critic_final`, `prompt_fixer`, `variant_writer`). `promptVersion` is `<role>@<n>`, the form of `Manifest.promptVersions`,
  and must be a version of `role`. The two are set together or not at all. Entries written under v1 have neither.
  Migration for eng-pipeline: add nullable `role` and `prompt_version` columns to `engine_ledger`, with no backfill. A null
  means the entry is not a Claude call or was written before v2. `authorizeCall` takes both fields, and a duplicate key with
  a different role is reported as not the same payload.
- **`VoiceKit` (13, `kits.ts`):** optional `wordsPerMinute` (positive, finite). Intake (6.1 step 4) uses the persona's rate
  when a persona loads, else the voice kit's. With neither, speech length is unknown and intake fails closed. Kits without
  the field stay valid.
- **Price table (`config/prices.ts`, `prices@2`):** `tokenRates` holds the Claude token rates of 11.1 in USD per million
  tokens, keyed by the OpenRouter model id in `config/routes.ts`. Opus 5.5 is $4 / $20 and Sonnet 5.5 $2 / $10. Haiku is
  costed at Haiku 4.5's $1 / $5 until Haiku 5.5's rate is confirmed (an owner check). `claude/rates.ts` still holds its own
  copy; the switch to `prices.tokenRates` is a one-line change for the lead.
- **Take gate (12.2, `thresholds.take`):** already held the Bible's numbers at v1, so nothing changes. The numbers are
  checked in `config.test.ts`. `thresholds.render.platformMaxBytes` stays null: the Bible does not give a size limit.

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

## 6. Stage specifications

Each stage below lists what it does, step by step, how it fails, and the tests that prove it works. Thresholds marked initial live in `engine/config/thresholds.ts`.

### 6.1 `intake`

- **Does:** validates the `ProductionRequest`, resolves kit references, decides which stages can be skipped from cache.
- **Steps:** (1) zod-parse the request. (2) Load style kit, persona, voice, characters and product kit; fail if any is missing. (3) Check every `claimId` is approved for the product. (4) Estimate spoken length: words ÷ voice's words-per-minute; reject if over `maxMs` by more than 10%. (5) Look up `VideoDNA` by `formatId` + reference hash; if found, mark `analyze_reference` as cached. (6) Check budget against the format's minimum estimate (cheapest plan for this many beats). (7) Check each `must` request maps to at least one visual type (section 7.3). (8) Create the request row and queue `analyze_reference` (unless cached) and `voice` in parallel.
- **Fails:** rejected with a list of reasons; nothing spent.
- **Tests:** a valid request queues two jobs; each invalid field produces its own reason; a cached format skips analysis.

### 6.2 `analyze_reference`

- **Does:** turns the example video into `VideoDNA` with its `EditGrammar`.
- **Steps:** (1) Fetch the reference to temporary storage. (2) Serverless ffmpeg: probe, scene-cut detection, frames at every cut plus 2 per second (cap 60), per-second motion, brightness and loudness, audio onset and beat grid. (3) Speech-to-text with word timestamps. (4) Claude Sonnet (vision) receives frames, transcript and cut list, and returns per segment: shot type, layers, on-screen text, beat role (structured output against `DnaSegment`). (5) Claude Sonnet with the Angle Bible (cached prefix) names the genome and transferable genes. (6) Code computes the `EditGrammar` from cut times, captions found by OCR in frames, zoom detection and audio metrics (section 8.1). (7) Store; delete source media; set `sourceDeletedAt`.
- **Fails:** missing transcript on a speech video, or fewer than 3 segments, retries once with denser frames; then the request is escalated.
- **Tests:** a fixture reel with known cuts yields cut times within 2 frames; the grammar of a fixture matches hand-labelled values within 10%.

### 6.3 `voice`

- **Does:** produces our narration and word timings.
- **Steps:** (1) Build text with SSML-like pacing marks from `emphasis` and beat boundaries. (2) TTS via the page's voice id. (3) Speech-to-text on the result for word timings (do not trust TTS-reported timings). (4) Measure LUFS and duration. (5) If over `maxMs`, re-run with faster pace (max 2 tries), then ask the Writer (Haiku) to tighten the longest beat without changing claims.
- **Fails:** mismatch between transcript and script above 3% word error triggers a retake.
- **Tests:** every script word appears in `words` in order; beat spans cover the full duration without gaps.

### 6.4 `plan`

- **Does:** chooses a visual type, duration, layer and source for every shot.
- **Steps:** (1) Align our beats to the reference segments by role and relative position. (2) Split long beats into shots so shot lengths follow the grammar's curve. (3) Run the five-step visual decision engine (section 7). (4) For each shot, build its `source`: prompt for generation (Claude Opus writes prompts using the style kit and character sheets), component + props, stock query, or existing asset. (5) Set `downgradeTo` for every generated shot. (6) Opus director check of the whole plan; swaps are logged as Decisions. (7) Validate: every `must` satisfied; total estimate within budget; no product beat without real imagery; no text in generation prompts.
- **Fails:** over budget re-runs step 3 with the remaining budget; a plan failing validation twice escalates.
- **Tests:** a fixture request produces a plan whose shots tile the voice duration exactly; a `must` request is always honoured; a budget that covers only the fixed per-master cost (section 14.2) plus nothing for generation yields an all-code plan.

### 6.5 `estimate_reserve`

- **Does:** prices each shot from the price table and reserves the total plus a redo allowance (initial 25% on generated shots).
- **Fails:** reservation larger than remaining workspace budget pauses the request (not an error).
- **Tests:** reservation equals the sum of shot estimates plus allowance; release on completion returns the unused part.

### 6.6 `produce_shot`

- **Does:** makes one take for one shot.
- **Steps:** (1) Check the asset cache by hash of (model class, prompt, refs, frames, duration, seed); return a hit at zero cost. (2) Ask the router for a provider (section 10). (3) Submit; poll asynchronous jobs with backoff; enforce the job timeout. (4) Download, validate codec, size and duration, normalise to 1080 × 1920 at 30 fps (serverless ffmpeg). (5) Write the `Take` with actual cost. (6) Queue `check_take`.
- **Component shots** (coded, kinetic, screen mock, rigged cartoon) skip generation: they are rendered as part of the composition and get a lightweight preview check instead.
- **Tests:** a cache hit costs nothing; a provider timeout retries on the next provider; a wrong aspect ratio is normalised.

### 6.7 `check_take`

- **Does:** the Critic decides accept, redo, downgrade or escalate for one take.
- **Steps:** (1) Code checks: duration within ±10% of shot, no black frames, flicker score, motion present for motion shots. (2) Similarity checks: product embedding vs hero image, presenter face vs persona, palette vs style kit. (3) Claude Haiku vision on 6 frames with the slop rubric (section 12): hands, faces, gibberish text, plastic skin, physics, artefacts. (4) Combine into `TakeVerdict`. If a shot had 2 takes, pick the best passing one.
- **Tests:** labelled good and bad takes from the gold set are classified at the target accuracy (section 12.4).

### 6.8 `edit`

- **Does:** writes the `EditDecisionList` from plan, chosen takes, word timings and grammar. Pure code; no model calls. Algorithm in section 8.2.
- **Tests:** deterministic for a given seed; all rules in section 8.3 hold on fixtures; total duration equals the voice duration plus the outro.

### 6.9 `compose`

- **Does:** compiles the EDL into a HyperFrames composition (section 9). Pure code.
- **Tests:** the composition validates with the HyperFrames linter; a fixture EDL renders locally in CI with the same output as the cloud.

### 6.10 `pre_render_gate`

- **Does:** blocks broken plans before money is spent on rendering: slideshow risk, delivery promise, safe zones, caption rules, rights, disclosure flags, budget (section 12.2).
- **Fails:** names the failing shots; only those go back to `plan` or `produce_shot`.

### 6.11 `render`

- **Does:** renders the composition on HeyGen's HyperFrames cloud with an idempotency key = hash of the composition. On two failures, falls back to Remotion Lambda (compiled from the same EDL), then Shotstack for component-free timelines.
- **Render integrity:** ffprobe confirms 1080 × 1920, 30 fps, duration ±100 ms, audio present.

### 6.12 `post_render_review`

- **Does:** reviews the actual MP4 (section 12.3): frames at every cut and 4 fixed positions, audio loudness, silence and clipping, caption presence and timing, Claude vision craft check, final slop pass.
- **Fails:** maps each failure to a shot or layer and re-queues the minimum.

### 6.13 `variants`

- **Does:** expands the variant matrix into EDL diffs and runs stages 9–12 for each. Text changes use Haiku plus the voice stage for new lines; product swaps re-run `produce_shot` only for product shots; caption and music swaps re-render only.
- **Tests:** a caption-only variant triggers no generation; a hook variant regenerates only hook shots.

### 6.14 `deliver`

- **Does:** writes the `Manifest`, reconciles the ledger, releases unused budget, emits learning events (section 16), and marks the request complete. Sampling (5% initial, 100% for a new format until 50 consecutive passes) creates review items after delivery without blocking it.

## 7. Visual types and the decision engine

Eleven visual types cover everything a short-form reel shows. The decision engine (`engine/plan/visual.ts`) picks one per shot in five steps; steps 1 to 4 are code and step 5 is one Claude Opus call for the whole plan.

&#91;embedded content: visual decision per beat\]

### 7.1 The catalogue

| Visual type | Best for | Recipe | Cost per 4 s (initial) | Downgrade to |
| --- | --- | --- | --- | --- |
| `ugc_presenter` | Confessions, roasts, opinions | Persona photo + voice segment + avatar API (lip-synced); short segments per beat | \~$0.20 | `kinetic_type` over stock |
| `product_hero` | Proof, reveal, CTA | Real hero image as first and last frame, image-to-video with a short motion prompt | $0.13 to $0.50 | `coded_graphics` product card |
| `stock_footage` | Lifestyle, context, B-roll | Pexels and Pixabay search; rank with multimodal embeddings against the shot description; trim to length | \~$0 plus search | `cinematic` budget model |
| `cinematic` | Spectacle hooks, impossible moments | Video model with first and last frame control; 2 takes | $0.50 to $1.00 | `product_hero` or `stock_footage` |
| `cartoon_rigged` | Jokes, mascots | SVG character rig + pose library animated in HyperFrames | \~$0 | `kinetic_type` |
| `cartoon_generated` | Pixar or anime-style scenes | Style keyframe (image API with character sheet), then image-to-video | $0.30 to $0.60 | `cartoon_rigged` |
| `coded_graphics` | Lists, tier boards, prices, comparisons, countdowns | Component + props | $0 | none needed |
| `react_clip` | Commentary on a moment | Presenter over an owned or licensed clip | presenter cost | `ugc_presenter` alone |
| `kinetic_type` | Punchlines, quotes, text-led hooks | Component + props | $0 | none needed |
| `stop_motion` | Playful product demos | 24 to 36 frames by image-to-image from the hero image, 8 to 12 fps, held frames | $0.45 to $0.65 per 3 s | `product_hero` |
| `screen_mock` | App demos, DM and text stories | Component + props | $0 | none needed |

### 7.2 Step 1: filter (hard rules)

Remove a candidate type for a shot if any rule applies:

1. The shot's beat has a `must` request the type can't deliver (mapping in 7.3).
2. The beat shows the product and the type would generate the product without the hero image (`cinematic` without a pinned frame, `cartoon_generated`).
3. The shot needs legible text, prices or a logo inside generated pixels (text is always a graphics layer).
4. The shot needs hands manipulating the product in generated video.
5. The type's cheapest cost exceeds the remaining budget.
6. The persona or character kit the type needs is missing.

### 7.3 `must` request mapping

The planner classifies each request's text (Haiku, structured output) into required properties: `real_product`, `person_talking`, `motion_spectacle`, `cartoon_style`, `data_or_list`, `text_led`, `real_world_context`, `stop_motion_style`, `screen_or_chat`. Each property maps to the types that can deliver it; a `must` keeps only those types.

### 7.4 Step 2: propose from the example

| Example shows (`ReferenceShotType`) | Proposed types, in order |
| --- | --- |
| `talking_head` | `ugc_presenter`, `react_clip` |
| `broll_montage` | `stock_footage`, `product_hero`, `cinematic` |
| `product_closeup` | `product_hero`, `stop_motion` |
| `onscreen_list` | `coded_graphics` |
| `sketch_joke` | `cartoon_rigged`, `cartoon_generated` |
| `spectacle` | `cinematic`, `product_hero` |
| `screen_record` | `screen_mock` |
| `react` | `react_clip`, `ugc_presenter` |
| `text_only` | `kinetic_type` |
| `other` | `stock_footage`, `kinetic_type` |

`may` requests add their types to the candidates.

### 7.5 Step 3: score

For each candidate type t on shot s:

```typescript
U(s, t) = 0.30 * beatFit(s.beatRole, t)        // table: how well t serves hook, proof, cta...
        + 0.20 * referenceMatch(s.refShot, t)  // 1 for the first proposal, 0.6 second, 0.3 others
        + 0.15 * styleFit(page.styleKit, t)    // kit lists preferred and banned types
        + 0.15 * winRate(page, t)              // learned; prior 0.5 until 30 samples
        - 0.10 * costShare(t, s, budget)       // estimated cost / remaining budget
        - 0.10 * artifactRisk(t)               // learned take failure rate; prior from 7.1
        + 0.05 * continuity(prev, t)           // same family as neighbour
        - 0.05 * repetition(t, last2)          // same type 3 shots running
```

All weights and tables are configuration (initial values above), refitted nightly by the learning loop (section 16).

### 7.6 Step 4: fit the budget

```typescript
assign every shot its cheapest remaining candidate
while (reservedBudget - planCost > 0) {
  pick the shot + upgrade with the highest (U_gain / cost_gain)
  if none fits the remaining budget: break
  apply upgrade
}
```

### 7.7 Step 5: director check

One Claude Opus call receives the plan as a table (shot, beat text, type, duration, prompt summary), the genome and the page persona. It returns structured output: `{ok, swaps: [{shotId, toType, reason}], promptEdits: [{shotId, prompt}]}`. Swaps must stay inside each shot's filtered candidates and the budget; anything else is ignored and logged.

## 8. The editing engine

The editing engine lives in `engine/edit/` and is pure, deterministic TypeScript: same inputs and seed, same edit decision list. It is what makes 1,000 different videos come out consistently well cut. Claude contributes only intent marks (emphasis words, payoff beat) through the script and plan.

### 8.1 Extracting the edit grammar (`engine/edit/grammar.ts`)

Runs inside `analyze_reference` on the ffmpeg and speech-to-text outputs.

| Field | Algorithm |
| --- | --- |
| `hookFirstCutMs` | Time of the first scene cut |
| `hookPayoffMs` | Start of the first segment whose beat role is `payoff` or `item`; else the second cut |
| `shotLengthMs` | Durations between cuts; p25, p50, p75; `curve` = median shot length in each tenth of the video |
| `rehookIntervalMs` | Median gap between pattern interrupts: cuts that change shot type, zoom jumps (frame scale change above 8%), or sound hits (onset strength above the 90th percentile) |
| `captions` | OCR on frames: words per caption block, vertical position band, colour and weight classes, whether the current word is highlighted (colour change between frames 100 ms apart) |
| `motion` | Zoom jumps per 10 s and their median scale; shake = high-frequency global motion; speed ramps = motion-speed discontinuities inside one shot |
| `transitions` | Classify each cut: hard, whip (motion blur spike), flash (brightness spike), zoom; share of each |
| `sound` | Music present if non-speech energy above threshold for over 60% of the duration; BPM from the onset envelope; energy curve per tenth; sound effects = short onsets not aligned to speech; silence before payoff if a gap over 300 ms precedes the payoff |
| `endsOnLoop` | Last frame within an image-similarity threshold of the first frame |

### 8.2 Building the edit decision list (`engine/edit/editor.ts`)

1. **Clock.** Timeline = voice duration + outro (from the style kit, default 0). All times in ms at 30 fps (round to 33.33 ms frames).
2. **Place shots.** Each `ShotSpec` occupies its beat span; multiple shots in a beat share it in plan order.
3. **Snap cuts.** Every cut moves to the nearest word gap of at least 80 ms within ±250 ms. If music is on, then to the nearest beat within ±120 ms, unless that would land inside a word.
4. **Fit shot lengths.** Compare each shot's length with the grammar curve at its position. Longer than 1.5× the target: split with a punch-in (same take, scale × `punchInScale`) or alternate take. Shorter than 0.5×: merge with the neighbour of the same type.
5. **Hook rules.** First frame must be a non-black, high-motion or face frame; motion starts within 300 ms; the hook caption appears by 500 ms; the first cut lands at `hookFirstCutMs` scaled to our duration.
6. **Re-hooks.** Insert a pattern interrupt (punch-in, type change, sound hit) at every `rehookIntervalMs`, prioritising words in `emphasis`.
7. **J and L cuts.** At beat boundaries, audio leads picture by 4 frames (J) or trails by 3 (L) where the example does; otherwise hard cut.
8. **Layer stack.** Back to front: base, cutaway, presenter (full or picture-in-picture by plan), graphics, captions, stickers. Graphics enter on their trigger word.
9. **Captions.** Group words into captions of the grammar's size range; break on punctuation and beat boundaries; highlight the current word; position in the grammar's band, moved off the presenter's face box.
10. **Effects.** Punch-ins on emphasis words; shake on impact sound effects if the grammar uses it; transitions sampled from the grammar's mix by the seed.
11. **Sound.** Voice at reference level; music ducked by 18 dB under speech with 150 ms attack and 400 ms release; sound effects on cuts and graphic drops at the grammar's density; silence before the payoff if the grammar has one; master to −14 LUFS integrated, −1 dBTP.
12. **Loop.** If `endsOnLoop`, the last 500 ms cross-fade to a frame matching the first.
13. **Seeded variety.** Every free choice (transition kind, punch-in scale within ±10%, sticker pick) uses a PRNG seeded from the request id, so re-runs are identical and variants differ.

### 8.3 Rules enforced on every EDL (initial values)

| Rule | Limit |
| --- | --- |
| No cut inside a word | 0 violations |
| Shot length | 0.4 s minimum; 6 s maximum for non-presenter shots |
| Caption length | 1–3 words (or the grammar's range) |
| Caption timing | On screen no later than the word starts, off no earlier than it ends |
| Safe zones | No caption or graphic in the top 10%, bottom 20% or right 12% of the frame |
| Face | Captions don't overlap the presenter's face box |
| Loudness | −14 LUFS integrated, true peak ≤ −1 dBTP |
| Black frames | None longer than 1 frame |
| Same shot type | Not more than 3 shots in a row (except `ugc_presenter` beats) |

Violations are fixed by the editor itself (it re-runs the relevant step); an EDL that still fails after one repair pass fails the `edit` gate.

## 9. Composition: compiler and component library

The compiler (`engine/compose/`) turns an `EditDecisionList` into a HyperFrames composition: HTML with timing attributes, clips on tracks, and sub-compositions for components. HyperFrames renders HTML, CSS and seekable animations deterministically with headless Chrome and FFmpeg, locally for CI and on HeyGen's cloud in production. Check the current HyperFrames documentation for exact attribute names; the compiler must emit only documented attributes and pass `hyperframes lint`.

### 9.1 Compiler rules

1. One root composition per EDL at 1080 × 1920, 30 fps; one track per EDL layer in stack order.
2. Media clips become video or image elements with start, duration and source in-point taken from the EDL; images get a Ken Burns move only if the plan asks for it.
3. Component clips become sub-compositions instantiated with their props as template variables.
4. The style kit is injected once as CSS custom properties (colours, fonts, caption style, motion intensity); components read only these variables, never hard-coded styles.
5. Audio: voice, music and sound effects as audio elements with gain; ducking is pre-rendered into the music stem by serverless ffmpeg before compose (renderers differ in live ducking support).
6. The colour grade (style kit LUT) is applied to media clips during normalisation in `produce_shot`, so every renderer sees graded footage.
7. Output: a directory (HTML, assets manifest) uploaded to S3; its hash is the render idempotency key.

### 9.2 Component library v1

Every component lives in `engine/compose/components/<name>/` with `component.html`, `props.ts` (zod), `fixtures/` (3+ prop sets) and a golden-frame test. Components must be seekable (any frame renderable without playing earlier frames) and must animate only from the composition clock.

| Component | Props (abridged) | Used by |
| --- | --- | --- |
| `captions.karaoke` | words with timings, highlight colour, band | All videos |
| `captions.boxed` | same + box style | Formats with boxed captions |
| `title.hook` | text, emphasis words, entrance | Hooks |
| `kinetic.punchline` | lines, rhythm, scale | `kinetic_type` |
| `list.tierBoard` | tiers, items with images, drop times | Tier-list formats |
| `list.countdown` | items, numbers, reveal times | Countdown formats |
| `list.ranking` | items, scores | Ranking formats |
| `compare.split` | left and right media, labels | Comparisons |
| `compare.beforeAfter` | two media, wipe timing | Transformations |
| `price.reveal` | old price, new price, currency, timing | Offers |
| `product.card` | hero image, name, three bullets | Product downgrade target |
| `cta.card` | text, DM keyword, arrow direction | Endings |
| `chat.thread` | messages, sender sides, typing timings | `screen_mock` DM stories |
| `screen.phone` | screenshots or a URL capture, scroll path | App demos |
| `react.layout` | base clip, presenter clip, picture-in-picture position | `react_clip` |
| `sticker.pop` | emoji or image, position, time | Re-hooks |
| `progress.bar` | duration, style | Retention aid |
| `label.lower` | text, side | Name tags, facts |
| `cartoon.rig` | rig id, pose timeline, expression timeline, lip-sync visemes | `cartoon_rigged` |
| `stopmotion.player` | frame URIs, fps, holds | `stop_motion` |

**Cartoon rigs:** each recurring character is an SVG rig with named parts (head, eyes, mouth shapes, arms) and a pose library. The planner writes a pose and expression timeline per beat; mouth shapes come from the voice track's phonemes (speech-to-text output mapped to visemes). This gives a funny, consistent cartoon with no video-model cost and no drift.

### 9.3 Fallback renderers

- **Remotion Lambda:** a second compiler targets a Remotion project that mirrors the component library's props. Parity is required only for the eight most-used components at first; others downgrade to `kinetic.punchline` or `product.card` when falling back.
- **Shotstack:** only for EDLs that use media, captions and simple text (no custom components).
- The render adapter records which renderer produced each video in the manifest.

## 10. Asset router and provider adapters

Every paid media call goes through one router (`engine/assets/router.ts`) that picks a provider for a model class from the gateway's route table (`engine/config/routes.ts`), enforces concurrency, applies the cache, and writes the ledger. Adapters (`engine/assets/providers/<name>.ts`) hide each vendor's API behind one interface.

### 10.1 Adapter interface

```typescript
interface ProviderAdapter {
  id: string;                               // 'openrouter:kwaivgi/kling-v3.0-std'
  modelClass: ModelClass;
  capabilities: { maxSeconds: number; minSeconds: number; firstFrame: boolean; lastFrame: boolean; refsMax: number; audio: boolean; aspect: string[] };
  price(spec: AssetSpec): { estimateUsd: number };     // from the price table
  submit(spec: AssetSpec, key: string): Promise<{ jobRef: string }>;  // key = idempotency key
  poll(jobRef: string): Promise<{ state: 'pending' | 'done' | 'failed'; uri?: string; error?: ProviderError; actualUsd?: number }>;
  cancel?(jobRef: string): Promise<void>;
}
type ProviderError = { kind: 'rate_limit' | 'timeout' | 'invalid_input' | 'content_policy' | 'server' | 'unknown'; retryable: boolean; message: string };
```

Synchronous APIs implement `submit` + an immediate `poll`. Adapters must never log credentials or full prompts containing personal data.

### 10.2 Scoring

Adapted from OpenMontage's selector. For each eligible adapter (capabilities satisfy the spec):

| Dimension | Weight (initial) | Source |
| --- | --- | --- |
| Task fit | 0.30 | Capability match plus learned pass rate for this visual type |
| Output quality | 0.20 | Gold-set score per model, refreshed weekly |
| Control | 0.15 | First and last frame, references, seed |
| Reliability | 0.15 | Success rate and p95 latency over the last 7 days |
| Cost efficiency | 0.10 | 1 − price / most expensive eligible price |
| Latency | 0.05 | Median completion time |
| Continuity | 0.05 | Same provider as the scene's earlier shots |

The highest score wins unless its concurrency bucket is full, in which case the next one is used. Every choice is a `Decision` on the shot.

### 10.3 Provider registry (initial, October 2026 list prices)

| Model class | Providers in priority order | Price |
| --- | --- | --- |
| `video.cinematic` | Kling v3.0 Standard; Veo 3.1 Fast; Seedance 2.5 (all via OpenRouter) | $0.126 / $0.10 / $0.1028 per s |
| `video.budget` | Seedance 2.0 Mini; Wan 3.0; Veo 3.1 Lite | $0.0336 / $0.0425 / $0.05 per s |
| `video.i2v_pinned` | Only models that pass the first-and-last-frame test (E2 task); Kling first | per model |
| `avatar` | HeyGen Avatar IV via OpenRouter | $0.05 per s |
| `image.keyframe` | Seedream 5.0 Flash; Seedream 4.5 | $0.018 / $0.04 per image |
| `image.edit` | Nano Banana 2; GPT Image 2 | token-priced |
| `tts` | Eleven v4; Gemini 3.8 Flash TTS | $40 per M characters; $9 per M output tokens |
| Speech-to-text | Hosted model with word timestamps (vendor chosen in E1) | per minute |
| Stock | Pexels; Pixabay | free with key (licence check in E2) |
| Background removal, upscaling, lip-sync | API vendors chosen in E2 | per call |
| Render | HeyGen HyperFrames cloud; Remotion Lambda; Shotstack | \~$0.10 per min at 1080p (verify); compute; $0.20 per min |

Prices live in `engine/config/prices.ts` and are overwritten by reconciled actuals: the ledger's rolling average replaces the list price after 50 calls.

### 10.4 Concurrency, caching and failures

- **Concurrency:** one bucket per provider, sized from the provider's documented limits (initial 10 for video, 20 for image, 30 for TTS). Jobs waiting for a full bucket stay queued; they don't spin.
- **Cache:** key = sha256 of (model class, normalised prompt, reference hashes, frame hashes, duration, seed, provider). A hit returns the stored asset at $0 and is recorded as a cache hit.
- **Failures:** `rate_limit` and `server` retry with backoff on the same provider, then the next; `timeout` cancels and moves to the next; `content_policy` and `invalid_input` don't retry: the planner rewrites the prompt once (Haiku), then downgrades the shot.
- **Circuit breaker:** a provider with over 30% failures in 10 minutes is skipped for 10 minutes.

## 11. Claude roles

Claude is called through one adapter (`engine/claude/`), which sends every call through the API gateway (`engine/gateway/`, OpenRouter by default), with structured output on every call: each role has a zod schema for its answer, and an answer that doesn't parse is retried once with the validation error, then fails the stage. Claude never returns free text that another stage acts on.

### 11.1 Roles

| Role | Stage | Model | Input | Output | Tokens (in / out, initial) | Cost per call |
| --- | --- | --- | --- | --- | --- | --- |
| `segmenter` | analyze | Sonnet, vision | Frames, transcript, cuts | `DnaSegment[]` | 26k / 3k | \~$0.08 |
| `genome` | analyze | Sonnet | Segments + Angle Bible (cached) | genome, transferable genes | 15k / 2k | \~$0.04 |
| `request_classifier` | intake, plan | Haiku | Visual request text | required properties | 1k / 0.2k | <$0.01 |
| `planner` | plan | Opus | DNA, voice spans, request, kits, candidates | shot prompts, layer choices | 20k / 4k | \~$0.16 |
| `director_check` | plan | Opus | Plan table, genome, persona | ok, swaps, prompt edits | 8k / 1k | \~$0.05 |
| `tightener` | voice | Haiku | Over-long beat, claims | shorter beat text | 1k / 0.3k | <$0.01 |
| `critic_take` | check\_take | Haiku, vision | 6 frames, rubric, refs | checks with scores | 8k / 0.5k | \~$0.01 |
| `critic_final` | post\_render | Haiku, vision; Sonnet if unsure | 12 frames, EDL summary | checks with scores | 15k / 1k | \~$0.02 |
| `prompt_fixer` | produce | Haiku | Failed prompt, failure kind | rewritten prompt | 1k / 0.3k | <$0.01 |
| `variant_writer` | variants | Haiku | Master script, matrix row, voice file | new lines | 2k / 0.5k | <$0.01 |

Rates used: Opus 5.5 $4 / $20 and Sonnet 5.5 $2 / $10 per million tokens in / out; Haiku costed at Haiku 4.5's $1 / $5 until Haiku 5.5's rate is confirmed; cached reads $0.20 per million; Batch API at half price. About $0.40 of Claude per master, plus Critic calls per take and render.

### 11.2 Prompt structure

Every role prompt is a versioned file `engine/prompts/<role>@<n>.md` with four parts:

1. **Role and rules:** what the role decides, what it must never do (invent claims, put text in generation prompts, change the script's meaning).
2. **Cached prefix:** stable reference material for the role: Angle Bible, component catalogue with props, visual-type catalogue, rubric, style-kit summary. Marked for prompt caching.
3. **Task input:** the artifacts as compact JSON (never raw model output from another stage as instructions).
4. **Output contract:** the zod schema, sent as the structured-output format.

### 11.3 Versioning, tests and challengers

- Each prompt version has a golden test set (10–30 inputs with expected properties, not exact text) run in CI with recorded responses, and live weekly.
- A new version ships as a **challenger** on a configurable share of traffic (initial 10%); the learning loop promotes it only if its gate pass rate and downstream results beat the current version.
- `Manifest.promptVersions` records the version of every role used for each video.

### 11.4 Cost control

- `priority: batch` requests send `segmenter`, `genome` and `planner` through the Batch API; results resume the pipeline when they arrive.
- Low-effort settings for Haiku roles; high effort only for `planner` and `director_check`.
- Images sent to vision roles are downscaled to the smallest size that keeps the check reliable (initial 768 px on the long side).

## 12. Quality system

Ten gates, each a function in `engine/review/gates/<gate>.ts` returning a `GateResult`. All limits are initial values in configuration, tuned from the gold sets. A gate never passes on an error or a missing value: unknown means fail.

### 12.1 Gates before production

| Gate | Checks (initial limits) |
| --- | --- |
| `request` | Schema valid; kits exist; claims approved; estimated speech within `maxMs` + 10%; budget above format minimum; every `must` deliverable |
| `dna` | At least 3 segments; transcript present when speech exists (speech energy above threshold); grammar fields all set; source deletion scheduled |
| `voice` | Word error vs script under 3%; duration within `maxMs`; LUFS measurable; no clipping |
| `plan` | Shots tile the voice duration with no gap or overlap over 1 frame; every `must` satisfied; no generation prompt contains text to render; every product beat uses real imagery; every generated shot has `downgradeTo`; estimate within budget |
| `budget` | Reservation succeeded |

### 12.2 Take and edit gates

**`take`** (per take, from `check_take`):

| Check | How | Limit (initial) |
| --- | --- | --- |
| Duration | ffprobe | Within ±10% of the shot |
| Black or frozen frames | ffmpeg frame differences | None over 2 frames |
| Flicker | Mean frame-to-frame brightness variance after motion compensation | Below 0.25 (normalised) |
| Motion present | Mean optical flow | Above 0.05 for motion shots |
| Product match | Embedding similarity of product crop vs hero image | ≥ 0.85 |
| Persona match | Face embedding similarity vs persona portraits | ≥ 0.80 |
| Palette | Share of pixels inside the style kit palette after grading | ≥ 0.70 |
| Generated text | OCR on frames finds no text | 0 words |
| Slop rubric (Haiku vision) | Hands, faces, anatomy, physics, plastic skin, morphing objects, background warping; each scored 0–1 | Every item ≥ 0.7; escalate if confidence < 0.6 |

**`edit`:** every rule in section 8.3.

### 12.3 Render gates

**`pre_render`** (on the composition and EDL, before paying for a render):

- **Slideshow risk** (from OpenMontage's six dimensions), each 0–1, weighted mean must be below 0.35: repetition (same shot type or composition repeated), decorative visuals (shots that don't illustrate their words), weak motion (share of static frames), shot intent (shots without a stated purpose in the plan), typography over-reliance (share of time where text is the main visual), unsupported cinematic claims (plan says cinematic, assets are stills).
- **Delivery promise:** the format's promise (for example "motion-led", "presenter-led") matches the measured mix of visual types.
- Safe zones, caption rules, rights (every asset has a licence record), disclosure flags set when AI people appear, budget remaining for render.

**`render_integrity`:** 1080 × 1920, 30 fps, H.264 + AAC, duration within 100 ms of the EDL, file size under the platform limit.

**`post_render`** (on the actual MP4):

- Frames at every cut ± 2 frames and at 10%, 35%, 65% and 90%: no black frames, no broken overlays (a graphics layer present in the EDL must appear in the frame).
- Audio: −14 LUFS ± 1, true peak ≤ −1 dBTP, no silence over 700 ms outside planned silences, no clipping.
- Captions: OCR-read captions match the script words and timing within 150 ms.
- Claims: OCR text on screen contains no claim outside the approved list.
- `critic_final`: craft and slop rubric on 12 frames; Sonnet re-checks if Haiku's confidence is below 0.6.

### 12.4 Gold sets and accuracy targets

- One gold set per Claude check (`critic_take`, `critic_final`, `segmenter`) and per code check with a learned threshold: 200 labelled examples to start (100 pass, 100 fail), growing with every human decision.
- Targets before a check may block without human review: recall on known failures ≥ 90%, false-fail rate ≤ 10%.
- Thresholds are refitted weekly to keep those targets; changes are logged.

### 12.5 Human review

- Review items (escalations and samples) show: the plan, every take with its checks, the rendered video, the manifest, and buttons to accept, choose another take, change the visual type, edit the prompt, or reject.
- Sampling: 100% of a new format's videos until 50 pass in a row, then 5% random; any gate threshold change resets sampling for affected formats to 20% for a week.
- Every human decision becomes a gold-set label with the reviewer's reason.

## 13. Consistency kits

Kits are versioned records in `engine_kits` that carry everything a page needs to look and sound the same in every video. Every shot request and component reads kits by id and version; no model is asked to remember a look. A kit change creates a new version; videos record the versions they used.

```typescript
type StyleKit = {
  styleKitId: string; version: number; pageId: string;
  palette: { primary: string; secondary: string; accent: string; text: string; background: string }; // hex
  fonts: { display: string; body: string; captions: string };       // web fonts available to the renderer
  captionStyle: { component: 'captions.karaoke' | 'captions.boxed' | 'captions.minimal'; highlight: string; weight: 400 | 500 | 700; case: 'sentence' | 'upper' };
  lut?: string;                          // colour grade file URI
  motionIntensity: 0 | 1 | 2 | 3;        // scales punch-ins, shakes, transitions
  preferredTypes: VisualType[]; bannedTypes: VisualType[];
  musicGenres: string[]; outroMs: number;
  stickers: string[];                    // allowed sticker set
};

type Persona = {
  personaId: string; version: number; pageId: string;
  portraits: string[];                   // 3 to 5 approved reference images
  description: string;                   // age range, style, setting; used in prompts
  wardrobe: string; setting: string;
  voiceId: string; wordsPerMinute: number;
  isAiGenerated: true;                   // drives disclosure
  consentRecord?: string;                // required if based on a real person
};

type CharacterSheet = {
  characterId: string; version: number;
  kind: 'rigged_svg' | 'generated';
  rigUri?: string; poses?: string[]; visemes?: string[];      // rigged
  references?: string[]; styleNotes?: string;                 // generated: front, side, expressions
};

type ProductKit = {
  productKitId: string; version: number; sku: string;
  heroImages: { uri: string; angle: 'front' | 'side' | 'back' | 'detail' | 'in_use' }[];
  cutouts: string[];                     // background-removed versions
  colours: string[]; logoUri?: string; name: string;
  approvedClaims: { claimId: string; text: string; proofUri: string }[];
  forbidden: string[];                   // words or claims never allowed
};

type VoiceKit = { voiceId: string; provider: string; providerVoiceId: string; direction: string; consentRecord?: string };
```

**Rules:**

- A persona or voice based on a real person requires a `consentRecord`; the intake gate rejects requests that reference one without it.
- Product embeddings for the take check are computed from `heroImages` and `cutouts` when the kit version is created.
- Persona face embeddings are computed from `portraits` the same way.
- Generated characters always send all `references` with every call (Seedance 2.5 accepts up to 50 references; other models fewer, so the router's capability check limits which models a character can use).
- Kits are created and edited in Meridian's UI; the engine treats them as read-only.

## 14. Budget and cost engine

No paid call happens without a reservation, and every call is reconciled to its real price. The budget engine lives in `engine/budget/`.

### 14.1 Flow

1. **Estimate** in `estimate_reserve`: price every shot from the price table (section 10.3), plus Claude, render and media-function costs, plus a redo allowance (initial 25% of generated-shot cost).
2. **Reserve** the estimate against the request budget and the workspace's monthly budget. If either would be exceeded, the request pauses (not fails) with a reason.
3. **Spend:** every adapter call writes a `LedgerEntry` with estimate and reservation before submitting.
4. **Reconcile:** on completion the adapter writes `actualUsd` (from the provider's response or billing API; else the list price, flagged as estimated).
5. **Release** unused reservation at `deliver`.

**Modes per workspace:** `observe` (record only), `warn` (record and alert on overrun), `cap` (refuse calls beyond the reservation). Production runs in `cap`.

### 14.2 Cost per master

The fixed part of every master is about $0.52: Claude roles about $0.40, Critic calls about $0.05, render about $0.05, speech-to-text and ffmpeg about $0.02. Generation varies by visual mix.

&#91;embedded content: initial estimates built in this Bible from list prices\]

### 14.3 Cost per variant

| Variant change | What runs | Cost (initial) |
| --- | --- | --- |
| Caption or on-screen text | Re-render | $0.05 to $0.07 |
| Music swap | Re-render | \~$0.06 |
| New hook line, presenter in hook only | TTS + 3 s avatar + render | \~$0.26 |
| Product swap | 2 product shots + render | \~$0.40 |
| New cinematic hook | 2 takes of 4 s + render | \~$1.06 |
| New persona or language | TTS + full presenter + render | \~$1.40 |

### 14.4 Budgets and alerts

- **The user sets the budget of every master** (owner decision, 2026-10-14). `ProductionRequest.constraints.budgetUsd` is required and has no default by format. Intake refuses a budget below the format minimum (the fixed per-master cost plus the cheapest plan for the request's beats) and tells the user the minimum; it never raises the budget on its own.
- Alert when a format's average real cost exceeds its estimate by over 20% for a day.
- The ledger feeds the usage screen: cost per master, per variant, per published video and per visual type.

## 15. Scale and operations

The engine must run 1,000 requests in a working day with no human attention except escalations. Throughput is limited by provider concurrency, not by Meridian, so operations are about buckets, caches and visibility.

### 15.1 Throughput model (initial, to measure in E6)

| Stage | Wall time per master |
| --- | --- |
| Intake | < 2 s |
| Analyze (uncached) | 60–120 s; cached 0 s |
| Voice | \~10 s |
| Plan + director check | 30–60 s |
| Produce (parallel, slowest shot) | 2–5 min |
| Take checks | \~10 s per take, parallel |
| Edit + compose + pre-render gate | < 10 s |
| Render | 60–120 s |
| Post-render review | \~30 s |
| **Total** | **6–12 min** |

With 50 requests in flight, 1,000 masters complete in roughly 2–4 hours if providers allow about 50–100 concurrent video jobs across the registry. Each visual type keeps at least two providers to spread the load.

### 15.2 Workers and scaling

- Worker processes are stateless; scale by queue depth per job type (initial: 1 worker per 20 queued jobs, max set per environment).
- Claude, render and provider calls are asynchronous: a worker submits, stores the external job reference, releases the lease, and a poller job picks up completion. No worker blocks for minutes.
- Serverless ffmpeg functions scale to zero; cold-start budget 3 s.

### 15.3 Observability

- **Per request:** a timeline of stages with durations, costs and gate results (shown in the review UI and the manifest).
- **Metrics:** queue depth and age per job type; p50/p95 duration per stage; provider success rate, latency and spend; cache hit rate by kind; gate pass rate by gate and format; redo and downgrade rates by visual type; cost per master and per variant.
- **Alerts:** dead-letter queue above zero for 15 minutes; any provider circuit open; gate pass rate dropping 20 points in an hour; spend above daily cap; render failures above 5%.
- **Logs:** structured JSON with request id, job id, stage, provider; never prompts with personal data, never keys.

### 15.4 Service levels (initial)

| Measure | Target |
| --- | --- |
| Rush request, master delivered | p95 under 20 min |
| Normal request | p95 under 2 h |
| Batch request | Within 24 h |
| Requests delivered without human touch | ≥ 90% after the first month |
| Delivered videos later failing a sample review | ≤ 3% |

### 15.5 Failure handling

- **Dead-letter:** a job that exhausts infrastructure retries stops; its request pauses with artifacts intact and appears in the review inbox with the error.
- **Provider outage:** circuit breaker skips the provider; plans already reserved on it re-route at produce time; if a whole model class is down, affected shots downgrade.
- **Render outage:** fall back renderer by renderer; if all fail, requests wait at `render` (no downgrade of quality silently).
- **Replay:** any request can be replayed from any stage with the same artifacts and seed, for debugging or after a fix.

## 16. Learning hooks

The engine doesn't run the learning loop, but it must emit everything the loop needs, and it must read everything the loop tunes. Nightly sleep mode (in the [Meridian handoff](https://claude.ai/code/artifact/73d4edea-b38b-4c83-9b82-bf8c6ecc2a57)) joins these events with published results.

### 16.1 Events the engine emits

Written to `engine_events` (append-only) at the moment they happen:

| Event | Payload |
| --- | --- |
| `plan.decided` | Plan id, every `Decision` with alternatives and scores |
| `take.checked` | Take id, visual type, provider, model, prompt version, every check score, verdict |
| `shot.downgraded` | Shot id, from type, to type, failure reasons |
| `review.decided` | Review item id, options shown, human choice, reason (gold-set label) |
| `gate.result` | Every `GateResult` |
| `video.delivered` | Manifest id, cost breakdown, timings |
| `cost.reconciled` | Ledger entry id, estimate vs actual |

### 16.2 What the loop tunes (read by the engine from configuration)

| Parameter | Used in | Tuned from |
| --- | --- | --- |
| Visual-type score weights and `winRate` per page × type | Section 7.5 | Published results joined to manifests |
| `artifactRisk` per type and per model | Sections 7.5 and 10.2 | `take.checked` pass rates |
| Router weights and quality scores | Section 10.2 | Gold-set scores, reliability stats |
| Gate thresholds | Section 12 | Gold sets, human decisions |
| Prompt challenger shares | Section 11.3 | Gate pass rates and published results per prompt version |
| Price table | Section 10.3 | `cost.reconciled` averages |
| Redo allowance | Section 14.1 | Observed redo spend per type |

### 16.3 Rules for tuned values

- Every tuned value has a floor, a ceiling and a maximum change per night (initial 15%); the engine clamps whatever it reads.
- Every configuration change is versioned; the manifest records the configuration version used.
- A 10% holdout of requests uses last week's configuration so drift can be measured.

## 17. Repository layout, standards and testing

### 17.1 Layout

```text
src/engine/
  contracts/          zod schemas for every type in section 4; index.ts exports all
  config/             thresholds.ts, weights.ts, prices.ts, budgets.ts, routes.ts (all versioned)
  gateway/            the one API gateway: transport.ts (the only fetch), providers, auth, OpenRouter client, Meridian credentials
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

## 18. Workstreams for an agent swarm

Fourteen workstreams, each owning modules and contracts with clear boundaries, so agents can build in parallel. Wave 0 (contracts) must land first; after that, every workstream builds against fixtures and recorded responses, then integrates.

&#91;embedded content: workstreams in build waves\]

| WS | Owns | Bible sections | Depends on | First task |
| --- | --- | --- | --- | --- |
| W1 | `contracts/`, `config/` | 4, 1 | none | All zod schemas, fixtures for each, config skeleton |
| W2 | `jobs/`, migrations, orchestrator, poller | 5, 15.2 | W1 | Engine job types on Meridian's queue; artifact table; advance-on-pass |
| W3 | `claude/`, `prompts/` | 11 | W1 | Client with caching, batch, structured output; `segmenter` role |
| W4 | `media/`, `functions/ffmpeg/`, speech-to-text, embeddings, OCR | 2, 6.2, 12 | W1 | Probe, cuts, frames, loudness functions with fixtures |
| W5 | `assets/` router, cache, providers | 10 | W1, W2 | Adapter interface + Seedance Mini, Avatar IV, Seedream, Eleven v4 adapters |
| W6 | `analyze/`, `voice/`, `edit/grammar.ts` | 6.2, 6.3, 8.1 | W3, W4 | Video DNA and grammar from fixture reels |
| W7 | `plan/` | 6.4, 7 | W3, W6 (fixtures) | Filter, propose, score, budget fit on fixture DNA |
| W8 | `edit/editor.ts`, `edit/rules.ts` | 8.2, 8.3 | W1 | Deterministic editor on fixture plans and timings |
| W9 | `compose/`, components, kit loading | 9, 13 | W1 | Compiler + 5 core components with golden frames |
| W10 | `render/` | 6.11 | W9 | HyperFrames cloud adapter with idempotency; render integrity check |
| W11 | `review/` gates, Critic, review inbox wiring | 12 | W3, W4 | Take gate with code checks + Haiku rubric; gold-set loader |
| W12 | `budget/` | 14 | W1, W2 | Estimate, reserve, reconcile; cap mode |
| W13 | `variants/`, `deliver`, `events/` | 6.13, 6.14, 16 | W8, W10, W11 | Caption-only and hook variants; manifest writer |
| W14 | Metrics, alerts, dead-letter, replay | 15 | W2 | Stage timeline and queue metrics |

**Rules for the swarm:**

- One agent (or agent team) per workstream; the owner of a contract approves changes to it (W1 owns all of section 4).
- Integrate through contracts only; never import another workstream's internals.
- Every workstream keeps a `STATUS.md` in its folder: done, in progress, blocked (with the blocking contract or decision).
- Integration happens at each phase gate (section 19), with the end-to-end test owned jointly by W2 and W13.

## 19. Build phases and acceptance tests

Six phases. A phase is complete only when every acceptance test passes in a **recorded live run** on real APIs, with artifacts and costs attached to the phase PR. Phases overlap: workstreams start the next phase's work on fixtures while integration finishes.

**Before E1:** the [Meridian handoff](https://claude.ai/code/artifact/73d4edea-b38b-4c83-9b82-bf8c6ecc2a57)'s phase 0 must be done or in progress, especially moving Veo off the preview model before 22 October 2026 and merging PR #39.

### E1 Skeleton (waves 0–1)

- [ ] W1: every contract in section 4 as zod with fixtures; config files with initial values.
- [ ] W2: engine job types, artifact table, orchestrator advancing on gate pass, poller for async calls.
- [ ] W12: estimate, reserve, reconcile, cap mode.
- [ ] W9: compiler and 5 components (`captions.karaoke`, `title.hook`, `kinetic.punchline`, `product.card`, `cta.card`) with golden frames.
- [ ] W10: HyperFrames cloud render adapter with idempotency and integrity check.
- [ ] W4: speech-to-text vendor chosen and wrapped; ffmpeg probe, frames, loudness functions.

**Acceptance:** a hand-written EDL with a stock clip, a TTS voice and three components renders through the cloud API to a valid 1080 × 1920 MP4; its ledger shows estimated and actual cost; 10 test renders' real bill recorded.

### E2 First four visual types (wave 2)

- [ ] W5: router, cache, circuit breaker; adapters for one budget video model, Avatar IV, Seedream, Eleven v4, Pexels, Pixabay.
- [ ] W5: first-and-last-frame test run on every video model; results recorded in the registry.
- [ ] W11: take gate with code checks, similarity checks and Haiku rubric; gold-set loader; review-inbox items.
- [ ] W9: `react.layout`, `list.tierBoard`, `compare.split`, `price.reveal`, `chat.thread`.
- [ ] Stock licence check for commercial social use, written into the rights rules.

**Acceptance:** for `ugc_presenter`, `product_hero`, `stock_footage` and `coded_graphics`, one shot each is produced, checked and passes; a deliberately bad take (warped product) fails the take gate.

### E3 Planner and editor (waves 2–3)

- [ ] W6: analyze stage producing Video DNA and edit grammar; voice stage with timings.
- [ ] W7: five-step visual decision, prompts, director check.
- [ ] W8: deterministic editor with all rules in 8.3.
- [ ] W3: `segmenter`, `genome`, `planner`, `director_check` roles with golden tests.

**Acceptance:** one reference reel + one script + one page's kits become a delivered master with no human step; the edit grammar of the output is within 15% of the reference's on shot length and caption size; a budget that covers only the fixed per-master cost yields an all-code plan that still delivers.

### E4 Gates (wave 2 integration)

- [ ] W11: pre-render gate with slideshow risk and delivery promise; post-render review; `critic_final`.
- [ ] Redo, downgrade and escalation routing in W2.
- [ ] Review inbox actions write gold-set labels.

**Acceptance:** a plan with five coded shots in a row is blocked by slideshow risk; a render with a deliberately broken overlay never reaches delivery; each of the four scenarios (clean pass, one redo, downgrade, human) runs end to end with correct manifests.

### E5 Full range and variants (waves 3–4)

- [ ] W5, W9: `cinematic`, `cartoon_rigged` (one character rig), `cartoon_generated`, `kinetic_type`, `stop_motion`, `screen_mock` complete.
- [ ] W13: variants for caption, music, hook, product, persona, language; manifest writer; events.
- [ ] W9: Remotion Lambda fallback compiler for the eight most-used components.

**Acceptance:** 20 variants from one master in under 15 minutes; a caption-only variant triggers no generation; a forced HyperFrames failure falls back to Remotion and still delivers.

### E6 Batch scale (all)

- [ ] W14: metrics, alerts, dead-letter handling, replay.
- [ ] Batch API planning for `priority: batch`.
- [ ] Concurrency buckets sized from measured provider limits.

**Acceptance:** 100 requests across 10 formats and 3 pages complete; measured p95 time and cost per master and per variant recorded and written back into this Bible; no request lost; at least 90% delivered without human touch.

## 20. Risks, open questions and verification

### 20.1 Risks

| Risk | Mitigation | Owner |
| --- | --- | --- |
| Licence contamination from OpenMontage (AGPL-3.0) or Hypit | Ideas only; no copied code; record the origin of each borrowed idea in the module README | All |
| Deterministic editing looks templated | Grammar measured per example; seeded variety; blind tests per format | W8 |
| AI presenters look uncanny | Short presenter segments, frequent cutaways, disclosure, real creator footage where budget allows | W7, W5 |
| Character and style drift | Kits on every call; rigged characters for recurring mascots; take checks against references | W9, W11 |
| Provider concurrency limits at batch scale | Two providers per type; buckets; batch overnight | W5, W14 |
| Frame pinning unsupported by some models | Test in E2; route `video.i2v_pinned` only to models that pass | W5 |
| Claude sees frames, not motion | Extra frames at cuts; ffmpeg motion and flicker metrics in every check | W4, W11 |
| Reference video copyright | Delete source media within 24 h; never reuse its footage, voice, music or lines | W6 |
| Cost and time estimates are wrong | Ledger replaces prices after 50 calls; E6 measures everything | W12 |
| Gates block too much or too little | Gold sets with accuracy targets before a check may block | W11 |

### 20.2 Open questions (owner to decide; agents must not guess)

- [ ] Speech-to-text vendor (word timestamps, music robustness, price).
- [ ] Background removal, upscaling and lip-sync vendors.
- [ ] Whether to keep Shotstack as a third renderer or drop it after E5.
- [ ] Music source: licensed library vendor and its terms for social use.
- [x] Default request budgets per format: none. The user sets the budget of every master (decided 2026-10-14; see section 14.4).
- [ ] Disclosure wording and placement standard for AI presenters.

### 20.3 Verify in the first two weeks

1. HyperFrames cloud render: real price per minute, speed, and whether every component (including SVG character rigs) renders identically to local renders.
2. Which OpenRouter video models accept both a first and a last frame.
3. Avatar IV via OpenRouter: maximum clip length, lip-sync with an externally supplied voice track, concurrency limits.
4. Speech-to-text word-timestamp accuracy on fast speech over music.
5. Pexels and Pixabay licence terms for commercial short-form posts.
6. Claude Haiku 5.5 pricing and whether OpenRouter passes through Anthropic prompt caching and batch (if Claude is ever routed there).

## 21. References

**Meridian planning documents** (this Bible supersedes them for anything in `src/engine/`):

- [Meridian handoff: state, target and next steps](https://claude.ai/code/artifact/73d4edea-b38b-4c83-9b82-bf8c6ecc2a57): codebase state, working rules, factory roadmap.
- [Video engine: full build specification](https://claude.ai/code/artifact/7e911f54-161c-47e6-8a95-cb43ff2c3bc5): OpenMontage analysis and the first engine design.
- [Content Factory master review](https://claude.ai/code/artifact/866b5081-469b-4136-8830-e816bd64dcbe): master-skills analysis, local-to-API swaps.
- [Claude brain, API compute](https://claude.ai/code/artifact/d4f87b7e-9ecf-4984-848c-0a1fa31e2193): Claude role costs, the timeline idea.
- [Self-improving loop and video engine](https://claude.ai/code/artifact/12bc8a9d-9778-487d-bc19-723f501c95ab): sleep mode and learning signals.

**Code and projects:**

- [Meridian](https://github.com/RTK23-dev/meridian), especially [PR #39](https://github.com/RTK23-dev/meridian/pull/39) (engines, credentials, perception) and [PR #45](https://github.com/RTK23-dev/meridian/pull/45) (UI, review inbox).
- [OpenMontage](https://github.com/calesthio/OpenMontage) (AGPL-3.0): pipelines, scored provider selection, slideshow risk, post-render review, budget governance. Ideas only.
- [HyperFrames overview](https://themenonlab.blog/blog/heygen-hyperframes-video-as-code) (Apache-2.0): HTML-to-video renderer.
- [master-skills](https://github.com/Jakeschincariol/master-skills) and [instagram-agent-skill](https://github.com/Jakeschincariol/instagram-agent-skill) (MIT): editing rules, hook formulas, humanizer.

**Pricing and platform sources (October 2026):**

- [OpenRouter video models](https://openrouter.ai/collections/video-models), [image models](https://openrouter.ai/collections/image-models), [speech models](https://openrouter.ai/collections/text-to-speech-models).
- [HeyGen API and HyperFrames pricing](https://www.g2.com/articles/heygen-api-pricing).
- [Claude Opus 5.5 pricing](https://techjacksolutions.com/?p=89318), [Claude Sonnet 5.5 pricing](https://emergent.sh/learn/claude-sonnet-5-5-pricing), [Anthropic API docs](https://docs.claude.com/en/api/overview).
- [Shotstack pricing](https://www.wireflow.ai/blog/shotstack-pricing), [render API comparison](https://motionbox.io/blog/best-editframe-alternatives-in-2026).
