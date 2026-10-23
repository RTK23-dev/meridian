# Meridian handoff: state, target and next steps

Oct 11, 2026 · @Victor

## Read this first

**This document is the single source of truth for the Meridian Content Factory as of 11 October 2026.** It replaces the nine planning documents written between 6 and 11 October (listed in section 10); where they disagree, this one wins.

**In one paragraph:** Meridian ([RTK23-dev/meridian](https://github.com/RTK23-dev/meridian)) is a TypeScript platform with a job queue, a deterministic decision gate called JEV, Bayesian learning and Meta publishing scaffolding. We are turning it into a **content factory for a portfolio of niche Instagram theme pages, each with its own Shopify store in the bio**. The factory finds reels that beat their creator's normal, studies why, rebuilds the concept around our product with AI, publishes, and learns from real views and sales every night. Everything runs on paid APIs: Claude for every thinking step, OpenRouter for video, avatar, image and voice, HeyGen's HyperFrames cloud for rendering. Nothing renders or infers on our own machines. The code has good foundations but **cannot yet publish to Instagram or read results**, and its Veo model dies on **22 October 2026**.

**Reading order for an agent arriving cold:**

1. Section 2 (code state) and section 7 (working rules), before touching anything.
2. Section 4 (locked decisions), so you don't reopen settled questions.
3. Section 6 (build plan): take the lowest-numbered unfinished task in the current phase.
4. Section 5 for the contract of the component you are working on.
5. Sections 8 and 9 only when a task touches cost or an open decision.

**The two deadlines that override everything else:**

- **22 October 2026:** the Veo preview model used in production shuts down. Move to a current Veo model before then.
- **Before any factory output matters:** Instagram publishing and insights ingestion must work (phase 0).

## Where the code stands

**Branches.** `main` is `0.1.0-beta.5` (8 October, 97 commits). All newer work sits in a stack of **draft pull requests opened 10 October, none merged**: #39 ← #40 ← #43 ← #44 ← #45, where each builds on the one before and #45 also contains #41, #42 and #46–#50.

| PR | Branch | Content | Test status |
| --- | --- | --- | --- |
| [#39](https://github.com/RTK23-dev/meridian/pull/39) | `claude/production-audit-defects-6htuuv` (51 commits) | Decision engines, honesty pass, credentials, transactions, perception | 1,164 / 1,166 source + 199 script tests pass on real PostgreSQL; 53 migrations; CI green |
| #40, #43, #44 | UI phases 1–3 | Design tokens, data layer, app shell and navigation | Per PR |
| [#45](https://github.com/RTK23-dev/meridian/pull/45) | `ui/phase-4-screens` (top of stack) | Every screen redesigned, review inbox, ops screens | **`npm test`, lint and build not run**; screenshots missing |
| — | `feat/instagram-discovery-factory` | Instagram discovery work | **Not reviewed:** branch pages could not be read by our tools; check it before duplicating work |

**Works (keep and build on):**

- Postgres job queue (`SKIP LOCKED`, leases, retries, dead-letter), S3 storage, health checks, workspace tenancy.
- Credential vault and one resolver per workspace; no key appears in any log or response.
- JEV decision gate: one engine per workspace (TypeSafe or OpenAI Decisions), fail-closed, every decision recorded with engine, model and policy version; literal rejects with no model call.
- Perception: ffmpeg frame sampling at real timestamps, Gemini perception behind its own provider.
- `VideoEngine` interface; production providers Gemini Omni, Veo, Google image (Nano Banana), Higgsfield and a manual Drive handoff (stub-tested only); cost-mode router (LOWEST\_COST / BALANCED); `variantMatrix`.
- Gates: perceptual-hash and embedding originality, claims, policy, rights.
- Learning: beta-binomial posteriors, recency decay, vertical cold-start priors, Benjamini-Hochberg FDR control.
- Honest Instant Rating: no invented shares, no velocity from a single snapshot.

**Broken or missing (each one is a task in section 6):**

| Problem | Where | Effect |
| --- | --- | --- |
| Veo preview model shuts down 22 October | Production provider | Video generation breaks |
| No live publishing | Organic adapters return "failed" | Nothing reaches Instagram |
| No live metrics | `fetchMetrics` returns null | Learning has no input |
| No calibration report | Decision engines | Almost everything routes to human review |
| Factory config never read | `factory_pipeline_configs` | Factory settings do nothing |
| Empty claims in factory gate | `worker.ts:330` passes `[]` to `claimsGate` | Claims cannot block factory output |
| Fake cost | `factory.produce` records 12 cents per variant | Cost ledger is wrong for video |
| Hypit mismatch | `scripts/hypit-bridge.mjs` expects a service at `HYPIT_BASE_URL` | Hypit is a skill, not a service: superseded by the timeline compiler |
| Keys outside the resolver | OpenAI, the OpenRouter chat path, Hypit read env vars | Per-workspace keys don't cover them |
| Source "Test Connection" always READY | Sources screen | False confidence |
| Unknown probability stored as 0 | Opportunities, learning | Skews ranking |
| Local pieces | WhisperX in `decode.ts`, local MiniLM embeddings, local timeline renderer | Must move to APIs |
| No Instagram discovery, Shopify or Cyclone adapter on `main` | — | Back half of the business missing |

**Cyclone** ([RTK23-dev/cyclone-fleet](https://github.com/RTK23-dev/cyclone-fleet)), the Android phone agent, works through MCP `observe` / `act` and a Skill Compiler; its physical Pixel 8 acceptance is still marked **unverified**.

## Status on 2026-10-22

- **Start here:** [CONTENT_FACTORY_PLAN.md](../CONTENT_FACTORY_PLAN.md), the execution plan. It has milestones M0 to M5. Each task names its files and its acceptance test.
- **Done on fixtures:** phases 0 to 6 of the 2026-10-22 build plan, with the commit table in [PHASE_LOG.md](PHASE_LOG.md). This includes the saved ad accounts, the video and avatar poll, the splice function and the revision race test.
- **Not done:** edit, compose and render plan steps; a remake through the splice; the Veo replacement. The Veo preview model shuts down on 22 October 2026, which is today.
- **Verified on 2026-10-22:** typecheck, lint (0 errors), build, the scripts suite (160 of 160) and the targeted src suites (177 and 126 tests). The full src suite has not run since 2026-10-21.
- **Live runs** belong to the owner. Agents hold no live keys.

## Status on 2026-10-17

The engine and the Content Factory page are code complete on recorded fixtures, and the owner's live runs are the gate for each phase.
The open items and decisions are in [PHASE_LOG.md](PHASE_LOG.md) (2026-10-17 entry) and [CHECKPOINT_2026-10-17_final.md](CHECKPOINT_2026-10-17_final.md).

- **Engine.** Contracts through v9. Model choice, brief requests (the engine writes the script), narration through OpenRouter speech,
  held-call reconciliation, and speech-to-text through Deepgram. ffmpeg runs on the worker. No live run is recorded.
- **Content Factory page** (`/content-factory`). Built on fixtures: a session is a brief request, text files up to 4000 characters are read
  into it, and PDFs are kept but not read.
- **Owner decisions** are listed in the checkpoint. The render fallback conflict is not resolved in code.

## Status on 2026-10-15

The state table above is the state on 11 October. This section is the state on 15 October, from [PHASE_LOG.md](PHASE_LOG.md) and a check of
the code. The engine phases E1 to E6 and the Factory items are code complete on recorded fixtures. **No gate in the build plan is met**,
because each gate needs a recorded live run, and agents hold no keys (NORTH_STAR decision 1). Each task below is marked with what was
checked. The boxes stay unticked until a gate passes.

| Phase | Status on 2026-10-15 |
| --- | --- |
| 0 Foundations | Partly done. 0.5 is done on fixtures. 0.1 and 0.4 are not done. 0.2 has a contradiction in the record (see below). 0.3 is built on fixtures. Gate not met. |
| 1 Skill library and render | Engine E1 is code complete on fixtures. The live acceptance (one master rendered through HeyGen, its bill read for ten renders) is not run. Gate not met. |
| 2 Claude chain and pixels | Engine E2 to E4 are code complete on fixtures. The speech-to-text vendor is the owner's to choose. Gate not met. |
| 3 Discovery and 3 live pages | Discovery through Apify and theme pages are built on fixtures. No page is live. Gate not met. |
| 4 Variants, learning, sales | Sleep mode, trial reels and Shopify attribution are built on fixtures. No live order or outcome is recorded. Gate not met. |
| 5 Scale | Not started. |

**Contradictions left unresolved, for the lead and the owner:**

- **PR #39.** CLAUDE.md says PR #39 closed unmerged. This branch's history contains the merge commit `0fa9235` ("Merge pull request #39
  from RTK23-dev/claude/production-audit-defects-6htuuv", dated 11 October 2026), and it is an ancestor of the head. Which is right is not
  decided here.
- **Locked decisions.** Decision 3 (Claude API direct) is superseded for the video engine by the owner's decision of 2026-10-14: model calls,
  Claude included, go through OpenRouter by default, and the Anthropic API stays as a route target (PHASE_LOG). Decision 5 is narrowed: the
  owner dropped Remotion Lambda on 2026-10-14, so Shotstack is the only fallback. Decision 9 is Apify, which the owner delegated to the lead
  on 2026-10-14. The table itself is unchanged.
- **The engine's data contract.** The build plan's timeline schema `meridian.timeline/v1` is not what the engine uses. The engine's plan is
  the scene plan `meridian.scene_plan/v1` with an edit decision list (Bible section 4). Where the two differ, the Bible wins inside `src/engine/`.

## The target

**The business.** A portfolio of niche Instagram theme pages (starting with 5: baby and parents, fashion, chains and jewelry, gadgets, car add-ons), each with its own Shopify store in the bio. Each page posts about 3 reels a day. Pages are bets with their own P&L: winners get budget, losers get re-themed. Money comes from store sales; ads are only placed behind reels that already beat their page's median organically.

**The core insight.** A viral concept is product-agnostic. How a reel hooks, who speaks, in what tone, in what order and with what proof can be lifted from a health-product reel and rebuilt to sell baby sleep aids. The factory copies those **genes**, never the footage, words or music.

**The honest promise.** Nothing goes viral on command. The factory takes far more shots, aims each with evidence, and spends real money only on what has already worked.

&#91;embedded content: the target system\]

**Scale target.** 5 pages live by week 12, 25 by week 24, 100 within 12 months, gated on quality and cost per order, not on the calendar.

## Locked decisions

These are settled. Build on them; reopen one only with new evidence, and say so in the PR description.

| # | Area | Decision | Why |
| --- | --- | --- | --- |
| 1 | Business | Our own theme pages and Shopify stores first; Meridian is not sold to other brands yet | Fastest proof of money; keeps third-party licences simple |
| 2 | Compute | Every model call and every render is a paid API; nothing runs on our machines except stateless serverless ffmpeg | No servers to run; cost per call is measurable |
| 3 | Brain | Claude API direct: Opus for the Director, Sonnet for study and timeline writing, Haiku for writing, critique and variants | Quality where it matters, cheap where volume is; direct API for batch and prompt caching |
| 4 | Pixels | OpenRouter for video, avatar, image and voice, with at least two models per layer | One key and ledger; providers swap on price or outage |
| 5 | Render | HyperFrames compositions rendered on HeyGen's cloud API; Remotion Lambda and Shotstack as fallbacks | HTML is what Claude writes best; Apache-2.0; no render servers |
| 6 | Video structure | Layered reels (base, presenter, cutaways, coded graphics, captions, sound); one master, many variants; presenter speaks in short separate segments | Variants re-generate seconds, not whole clips |
| 7 | Timeline | Our own word-anchored timeline JSON and a versioned component library; Claude fills component props and never writes render code per video. Hypit's ideas are rebuilt clean-room, none of its code is copied | Cheaper, validatable, no licence ties |
| 8 | Publishing | Official Instagram Content Publishing API with trial reels; phones never post | Safe for the pages; built-in concept testing |
| 9 | Discovery | Instagram data API (Apify or Bright Data) for volume; Graph API for our own accounts; Cyclone phones as observe-only feed radar | Each covers what the others can't |
| 10 | Rating | Outlier multiple = views ÷ creator's median of last 30 reels, shrunk by empirical Bayes; snapshots at 0, +24 h, +72 h | Ranks format strength, not fame |
| 11 | Copying | Copy genes (hook, voice, arc, structure, proof, edit grammar, ask), never footage, words or music | Originality and law |
| 12 | Learning | Optimise contribution per 1,000 views; 10% holdout on last week's playbook; changes enter as challengers | Prevents learning clickbait |
| 13 | Craft knowledge | Hook library, humanizer lexicon, edit rules and voice files imported from master-skills and its sibling repos as versioned data, credited | Tested method, MIT licensed |
| 14 | Disclosure | AI label on realistic AI people; paid-partnership label where relevant; no invented people presented as real customers | EU AI Act Article 50 (since 2 August 2026), EU consumer law |
| 15 | Ads | Ad money only behind reels that beat their page's median organically; break-even return on ad spend = 1 ÷ gross margin | Never pay to test an unproven creative |

## Component contracts

Each stage is a job on Meridian's queue with a typed input, a typed output and a cost written to the ledger. Every output is validated before the next stage reads it; an invalid output is retried with the validation error, then sent to review.

| Stage | Build as | Input → output | Rules |
| --- | --- | --- | --- |
| 1 Scout | New source adapters: Instagram data API, Cyclone scout, Graph API | Niche → candidate reels: permalink, creator, views, likes, comments, caption, audio, posted time, creator's median views over 30 reels | Store aggregates; comment text pseudonymised; never scrape with a page account |
| 2 Rater | Extend Instant Rating | Snapshots → outlier multiple, velocity, action rate, comment intent, tier S/A/B/C with interval and evidence | Unknown stays null, never 0 |
| 3 Deconstructor | Extend Creative DNA v2 (`decode.ts`) | S/A reel → **Video DNA**: segments anchored to word ids, layers per segment, edit cues, ffmpeg motion and loudness stats | Hosted speech-to-text replaces WhisperX |
| 4 Strategist | New Claude job (Sonnet) | Video DNA → genome (hook, voice, arc, structure, proof, edit grammar, ask), hook formula id, transferable vs not | Every claim cites a timestamp or comment |
| 5 Director | New Claude job (Opus) | Genome + product + page persona + budget → **beat sheet** | Must fit the budget; picks shot type per beat |
| 6 Writer | New Claude job (Haiku) | Beat sheet + voice file → script words, 10 hooks, caption, DM keyword | Must pass the humanizer gate |
| 7 Timeline author | New Claude job (Sonnet, structured output) | Beat sheet + script → **timeline JSON** `meridian.timeline/v1` | Only components from the library; schema-validated |
| 8 Producer | Router over OpenRouter and HeyGen | Asset requests → cached assets keyed by input hash | Reuse before generate; cost to ledger |
| 9 Compiler + render | New `VideoEngine` implementation | Timeline → HyperFrames HTML → MP4 via HeyGen cloud | Idempotency key = hash of the timeline |
| 10 Critic | Engine gate (`runEngineGate`) + code checks | Rendered frames, timeline, audio → pass or fail per layer with rule and reason | Two redo loops, then review inbox |
| 11 Variator | Extend `variantMatrix` | Master timeline + matrix → variant timelines as small diffs | Probe 5 cheap variants before generated ones |
| 12 Publisher | Replace organic adapters | Passed MP4 → trial reel, then feed, with per-reel UTM tag and DM keyword | Receipt must carry a real Instagram media id |
| 13 Learner | Nightly sleep-mode jobs | Insights, store analytics, orders → updated playbook | Holdout, challengers, change budget of 15% per night |

**The manifest every rendered video carries:**

```json
{
  "video_id": "vid_01H...",
  "page": "chains",
  "source": {"reel": "ig:reel/abc123", "outlier": 14.2, "tier": "S"},
  "genome": {"hook": "bold_ranking_claim", "voice": "confident_roast", "structure": "rank_slam_x5"},
  "prompt_versions": {"director": "dir@7", "writer": "wri@12", "timeline": "tl@4"},
  "models": {"presenter": "heygen/avatar-iv", "intro": "kwaivgi/kling-v3.0-std", "voice": "eleven-v4"},
  "timeline_hash": "sha256:...",
  "variant_of": null,
  "cost_usd": {"brain": 0.71, "generation": 3.00, "render": 0.05, "total": 3.76},
  "gates": {"originality": "pass", "visual_slop": "pass", "text_slop": "pass", "craft": "pass", "claims": "pass", "disclosure": "pass", "rights": "pass"},
  "publish": {"ig_media_id": null, "utm": "reel_vid_01H", "dm_keyword": "CHAIN"}
}
```

The timeline schema and a full worked example are in [Claude brain, API compute](https://claude.ai/code/artifact/d4f87b7e-9ecf-4984-848c-0a1fa31e2193); the six shot types and their costs are in [Self-improving loop and video engine](https://claude.ai/code/artifact/12bc8a9d-9778-487d-bc19-723f501c95ab).

## Build plan

Take the lowest-numbered unfinished task in the earliest open phase. A phase is done only when its gate is met with a recorded live run, not when its code merges. Weeks are estimates for one strong developer working with coding agents.

&#91;embedded content: build roadmap · 6 phases, a gate on each\]

### Phase 0: Foundations (weeks 1–2)

- [ ] **0.1 Veo** — move the production Veo provider off the preview model to a current Veo model through OpenRouter (Veo 3.1 Fast or Lite). **Deadline 22 October.**
  _Status 2026-10-15: not done. No production Veo provider exists in this repo (CLAUDE.md). The engine's route table lists `google/veo-3.1-lite` through OpenRouter as an unverified target (`src/engine/config/routes.ts`)._
  _Status 2026-10-23: the owner's first decision removed Veo from the route and price tables. The operating brief that followed replaces the global exclusion: exclusions are scoped to one provider endpoint with a reason (`src/engine/config/model-exclusions.ts`, empty today). Veo 3.1 is a listed candidate, chosen by capability and price. The box stays open until the owner confirms the replacement._
- [ ] **0.2 Merge #39** after one live smoke call per provider (Gemini, OpenAI, TypeSafe, OpenRouter, Higgsfield, Nano Banana) with real keys.
  _Status 2026-10-15: not done. CLAUDE.md records PR #39 as closed unmerged, but the merge commit is in this branch's history. See the contradictions above._
- [ ] **0.3 Instagram publishing** — replace the Instagram organic adapter with the Content Publishing API, including trial reels, on one owned test account.
  _Status 2026-10-15: built on fixtures. Instagram publishes through a signed link and a Reels container, and a trial reel records its strategy (FACTORY.md, Publish). No live account has been used._
- [ ] **0.4 Insights** — implement `fetchMetrics` for our own professional accounts on a schedule.
  _Status 2026-10-15: not done. `fetchMetrics` returns null for Instagram, Facebook, YouTube and TikTok (`src/lib/meridian/distribution/`)._
- [ ] **0.5 Factory fixes** — read `factory_pipeline_configs`; pass the brand's real claims at `worker.ts:330`; record real call costs in `factory.produce` instead of 12 cents.
  _Status 2026-10-15: done on fixtures. `factory_pipeline_configs` is read (`factory/pipeline-config-store.ts`); the claims gate gets the brand's rules (`factory/worker.ts`); no 12-cent constant is left in `factory/`. Costs come only from metered calls._
- [ ] **0.6 Discovery branch** — review `feat/instagram-discovery-factory` and fold anything reusable into phase 3.
  _Status 2026-10-15: not checked in this pass. Discovery at volume (B1 and B2) is built on fixtures on this branch._
- [ ] **0.7 UI stack** — run test, lint, build and screenshots on #45, then merge #40 to #45.
  _Status 2026-10-15: the merges of #40, #43, #44 and #45 are in this branch's history (`88c94ae` merges #45). The test, lint and build results for #45 are not recorded here._

**Gate:** a test reel posts with a real Instagram media id; Veo renders after 22 October; insights for that reel arrive. _Not met on 2026-10-15._

### Phase 1: Skill library and render (weeks 1–4)

- [ ] **1.1** Import as versioned data, with attribution: 26 hook formulas, humanizer lexicon (113 terms, 17 classes, 11 tells), edit craft rules, one voice file per page.
  _Status 2026-10-15: not found. No hook-formula or humanizer data is in `src/` or `scripts/`._
- [ ] **1.2** Timeline schema `meridian.timeline/v1` with a zod validator.
  _Status 2026-10-15: superseded in the engine. The engine uses `meridian.scene_plan/v1` and an edit decision list (Bible section 4). The string `meridian.timeline` is not in `src/` or `scripts/`._
- [ ] **1.3** Component library v1 in HyperFrames HTML: three caption styles, tier board, countdown, price reveal, split screen, react layout, product card, title card, CTA card, progress bar.
  _Status 2026-10-15: built on fixtures as engine components: `captions.karaoke`, `title.hook`, `kinetic.punchline`, `product.card` and `cta.card` (E1); `react.layout`, `list.tierBoard`, `compare.split`, `price.reveal` and `chat.thread` (E2); `kinetic.type`, `screen.mock`, `character.rig` and `stopmotion.player` (E5). The PHASE_LOG names no countdown or progress bar._
- [ ] **1.4** Compiler: timeline JSON → HyperFrames composition.
  _Status 2026-10-15: built on fixtures (`src/engine/compose/`). Golden frames passed 30 of 30 at E2._
- [ ] **1.5** HeyGen HyperFrames cloud render as a `VideoEngine`, with idempotency keys and cost to ledger.
  _Status 2026-10-15: built on fixtures (`src/engine/render/`). The endpoints come from the HyperFrames CLI source and are not live-verified. The price per minute is unknown (owner item). The live run is pending._
- [ ] **1.6** Claude adapter: Anthropic SDK, prompt caching, Batch API, keys via the credential resolver, tokens and cost to ledger.
  _Status 2026-10-15: built on fixtures, with a change of route. Claude roles go through the gateway and OpenRouter by default (owner decision, 2026-10-14), and the Anthropic API is a route target. Token rates are in `src/engine/claude/rates.ts`. No live call has been made._

**Gate:** a hand-written timeline renders through the API in under 2 minutes, and the bill for 10 test renders has been read. _Not met on 2026-10-15: the live run is not recorded._

### Phase 2: Claude chain and pixels (weeks 3–6)

- [ ] **2.1** Deconstructor with hosted speech-to-text (replaces WhisperX).
  _Status 2026-10-15: not done. The speech-to-text interface has a recorded adapter. The vendor is the owner's decision (Bible 20.2)._
- [ ] **2.2** Strategist, Director, Writer and Timeline author jobs, each a versioned prompt.
  _Status 2026-10-15: partly built on fixtures as engine roles, each run through `runRole` with a structured answer (for example `analyze_reference`, `genome`, `planner`, `director`, `director_check` and `variant_writer@2`, PHASE_LOG E3 and E5)._
- [ ] **2.3** OpenRouter adapter for video, avatar, image and voice, with an asset cache keyed by input hash.
  _Status 2026-10-15: built on fixtures (E2: router, cache and circuit breaker; adapters for OpenRouter video, image and speech). Avatar IV is NOT_CONNECTED: no verified OpenRouter API exists for it._
- [ ] **2.4** Critic and the seven gates (the quality-system section of the [master review](https://claude.ai/code/artifact/866b5081-469b-4136-8830-e816bd64dcbe)).
  _Status 2026-10-15: built on fixtures: the E2 take gate, and the E4 pre-render gate, post-render review and `critic_final`._
- [ ] **2.5** Retire `scripts/hypit-bridge.mjs` and the `HYPIT_BASE_URL` setting.
  _Status 2026-10-15: not done. `scripts/hypit-bridge.mjs` is still in the repo, and `HYPIT_BASE_URL` is still in `.env.example`._

**Gate:** one source reel in, one master and 20 variants out, with measured cost per video. _Not met on 2026-10-15._

### Phase 3: Discovery and 3 live pages (weeks 5–8)

- [ ] **3.1** Instagram data API adapter (Apify or Bright Data), with creator medians.
  _Status 2026-10-15: built on fixtures with Apify (`src/lib/meridian/sources/apify/`), with creator medians over the last 30 reels. The Apify key and plan price are open. Bright Data is not built._
- [ ] **3.2** Cyclone scout adapter, after a 24-hour unattended run on a real phone.
  _Status 2026-10-15: an adapter file exists (`src/lib/meridian/discovery/cyclone-scout-adapter.ts`). The 24-hour unattended run on a real phone is not recorded._
- [ ] **3.3** Snapshot scheduler (0, +24 h, +72 h) and the Instant Rating on real snapshots.
  _Status 2026-10-15: built on fixtures (`src/lib/meridian/discovery/snapshot-scheduler.ts`; reel ratings in `grading/reel-rating.ts`). Real snapshots need live data._
- [ ] **3.4** Three pages posting daily through trial reels.
  _Status 2026-10-15: not done. Theme pages and trial reels are built on fixtures. No page is live._

**Gate:** 1,000 rated candidates per niche per week; 3 pages posting daily. _Not met on 2026-10-15._

### Phase 4: Variants, learning, sales (weeks 8–12)

- [ ] **4.1** Probe-then-scale variants.
  _Status 2026-10-15: not verified in this pass._
- [ ] **4.2** Sleep mode v1: collect, score, plan tomorrow, morning brief; 10% holdout from day one.
  _Status 2026-10-15: built on fixtures (B6). A night gathers, grades and plans, and waits at produce for approval. The 10% holdout is recorded, and production does not read it yet (FACTORY.md, Sleep mode)._
- [ ] **4.3** Per-reel UTM tags, DM keywords and the Shopify order webhook into Meridian.
  _Status 2026-10-15: built on fixtures (B4 link fields; B5 webhook at `/api/webhooks/shopify`). No live shop has sent an order._
- [ ] **4.4** First calibration report from about 200 hand-labelled decisions.
  _Status 2026-10-15: not done. Per-brand calibration reports are built, and each needs 100 measured outcomes per question. No set of hand-labelled decisions is recorded._

**Gate:** cost per order measured per reel; 5 pages live. _Not met on 2026-10-15._

### Phase 5: Scale (weeks 12–24)

- [ ] **5.1** Sleep mode v2: gene refits, prompt challengers, model-route reviews.
  _Status 2026-10-15: not started._
- [ ] **5.2** Shared niches and cheaper-model swaps.
- [ ] **5.3** 25 pages.

**Gate:** cost per published reel under $0.80 with blind-test quality holding. _Not met on 2026-10-15._

## Working rules for agents

The 10 October honesty pass removed fake receipts and invented numbers from this codebase. These rules keep them out.

**Honesty**

1. **Fail closed.** Unknown values stay null, never 0 or a guess. An unconnected service says NOT\_CONNECTED; it never returns success.
2. **Done means a recorded live run**, not merged code or green stubs. Write the run's evidence (ids, costs, screenshots) into the PR.
3. **Label every number** as measured, fitted or a prior. Nothing hand-set is called "calibrated" or a "probability".

**Money and keys**

4. **Every model, API and render call goes through the router and the credential resolver.** Never read an API key from the environment directly.
5. **Every call writes its cost** to the ledger with stage, page, concept and video id.
6. **Every paid job sends an idempotency key** (the input hash), so a retry never bills twice.
7. **Respect budgets.** The Director's per-master ceiling and each page's monthly budget are soft limits with a tolerance (owner direction 2026-10-23). Work proceeds within the allowance, the budget plus its tolerance. Beyond it, the request pauses for an approval; never spend past an allowance without one.
8. **Secrets never enter git, logs or chat.** An OpenRouter key was exposed in a screenshot during planning; confirm it has been rotated before using OpenRouter.

**Data and content**

9. **Every model output is schema-validated** before the next stage reads it: retry once with the validation error, then route to the review inbox.
10. **Every rendered video carries its manifest** (section 5).
11. **Copy genes, never content.** No source footage, music, voice or script lines enter a render; every asset has a licence on record.
12. **Accounts are sacred.** Page accounts never scrape; phones only observe at human pace; no automated likes, follows or comments.
13. **Prompts are versioned data.** Changes ship as challengers on a slice of traffic, never as silent replacements.

**Process**

14. **Small PRs on top of `main`.** Merge #39 first; don't open new stacked drafts on an unmerged base.
15. **Don't reopen locked decisions** (section 4) without new evidence written in the PR.
16. **Update this document** when a gate passes or a decision changes: tick the task, add a line to the decision table, keep it the single source of truth.

## Costs and budgets

All-in, a published reel costs about **$1.07 at 5 pages and $0.76 at 25 pages**. Every figure here is an estimate from list prices; the cost ledger replaces them after the first 100 renders, and this section should then be updated. _Status 2026-10-15: the HyperFrames price is unknown and stays null in the engine's configuration until the owner confirms it (PHASE_LOG), so the render stays fail-closed. The other engine prices are not verified live._

**Unit prices used** (as listed in October 2026):

| Item | Price | Item | Price |
| --- | --- | --- | --- |
| Claude Opus 5.5 | $4 / $20 per M tokens in / out | Avatar IV (OpenRouter) | $0.05 / s |
| Claude Sonnet 5.5 | $2 / $10 | Kling v3.0 Standard | $0.126 / s |
| Claude Haiku (costed at 4.5) | $1 / $5 | Seedance 2.0 Mini | $0.0336 / s |
| Cached input / Batch API | $0.20 per M / half price | Veo 3.1 Fast / Lite | $0.10 / $0.05 per s |
| HyperFrames cloud render | about $0.10 / min at 1080p (verify) | Seedream 5.0 Flash | $0.018 / image |
| Instagram data API | about $1.50 / 1,000 results | Eleven v4 voice | $40 / M characters |

**Per master (30-second reel, including retries and about $0.71 of Claude work):** code-rendered explainer $0.78; react over a licensed clip $1.76; AI UGC presenter with tier board $2.13; reference UGC clone $2.19; cinematic hook with presenter $3.75; fully generated cinematic $6.85.

**Per variant:** caption or text change $0.02; new hook with presenter only in the hook $0.21; product swap $0.34; new cinematic hook $1.01; new presenter or language $1.35. Average across a normal mix: about $0.32.

**Per month:**

|  | 5 pages | 25 pages |
| --- | --- | --- |
| Reels published | 450 | 2,250 |
| Masters and variants | $261 | $1,128 |
| QA rejects remade (+20%) | $52 | $226 |
| Discovery (data API, scout SIMs) | $152 | $304 |
| Speech-to-text, embeddings, storage | $15 | $50 |
| **Total** | **about $480** | **about $1,710** |

**Page economics (base case from the bold-goal deck, updated):** about 3 million views a month gives about 36 orders at $35 and roughly $650 in contribution; page running costs are about $170 (content, discovery share, Shopify and apps), leaving about **$480 per page per month**. A page at 0.5 million views loses about $110; one at 15 million makes about $5,900. Breakouts decide profit.

**Budgets to enforce in code:** $8 ceiling per master; about $100 a month of video per page at 5 pages; ads only behind proven reels, with break-even at a return of 2.2 on ad spend for a 45% margin.

## Open decisions and risks

**Open decisions (owner to answer; agents should not guess):**

- [ ] **Renderer sign-off:** confirm HyperFrames on HeyGen's cloud as primary after the phase-1 test bill.
  _Status 2026-10-15: open. Shotstack is the only fallback (owner, 2026-10-14). The bill is not read yet._
- [ ] **Discovery vendor and volume:** Apify or Bright Data; 1,000 candidates per niche per week is assumed.
  _Status 2026-10-15: the vendor is Apify (the owner delegated the choice to the lead, 2026-10-14). The 1,000 a week is the initial value in the code. The plan price is open._
- [ ] **First three niches** for phase 3, and each page's persona (becomes its voice file).
- [ ] **Stores:** who sets up the Shopify stores, sources products (45%+ margin, $30+ order value) and handles fulfilment.
- [ ] **Month-one budget:** about $480 a month running cost at 5 pages, plus build time.
  _Status 2026-10-15: not recorded. The workspace's monthly video budget is a Settings field with no default (2026-10-14)._
- [ ] **Reviewer:** who checks new concepts daily until they pass 50 in a row.
- [ ] **Scout fleet:** number of Cyclone phones (one per niche assumed).

**Top risks:**

| Risk | Mitigation |
| --- | --- |
| Veo shutdown on 22 October breaks video | Task 0.1, first thing |
| Meridian still cannot publish or read results | Phase 0 before any factory work |
| HyperFrames cloud pricing unclear (sources disagree) | Read the bill for 10 test renders; Remotion and Shotstack fallbacks |
| Instagram data APIs are unofficial; comments are personal data under GDPR | Aggregate and pseudonymise; never use page accounts; official Graph API for our own accounts |
| Cost and quality numbers are estimates | Ledger and blind tests replace them in month one |
| Nothing goes viral on command | Volume of cheap probes, evidence-based concepts, money only behind proven reels; pages killed or re-themed monthly |
| Regulated products and claims | Skip medicine and health claims; baby products meet EU safety rules; claims gate on every render |

## Reference

**Earlier planning documents, oldest first.** Read for depth on one topic; where any of them conflicts with this handoff, this handoff wins.

| # | Document | Still useful for | Superseded on |
| --- | --- | --- | --- |
| 1 | [Deep dive and build plan](https://claude.ai/code/artifact/1d2e53c4-2c95-4c4d-a61d-6e5a3d315535) | Angle Bible dimensions, Instant Rating maths, the study engine | Browser vs phone detail |
| 2 | [Content Factory v2](https://claude.ai/code/artifact/57004923-8838-4996-99df-6d25777077ba) | First Hypit analysis | Hypit as the engine (decision 7) |
| 3 | [Money in vs money out](https://claude.ai/code/artifact/33544dae-9e9e-496c-90e0-12a666b2dac3) | Cheapest model per decision, probe-then-scale economics | Cost figures |
| 4 | [Theme-page commerce deck](https://claude.ai/artifact/Kudv1QZFivfdyUNddvZVh2) | The business plan, funnel, scenarios, guardrails | Content cost per page (section 8) |
| 5 | [Self-improving loop and video engine](https://claude.ai/code/artifact/12bc8a9d-9778-487d-bc19-723f501c95ab) | Sleep-mode jobs, learning signals, the six layers and shot types | — |
| 6 | [Review of the 10 October push](https://claude.ai/code/artifact/bf06e5d2-4cea-48a4-8f90-612da0a2acf8) | PR stack findings | — |
| 7 | [Video engine: concrete plan](https://claude.ai/code/artifact/728cd018-dd79-4b7e-85cf-6c9657bff35c) | Agent crew, Video DNA example, variant costs | Hypit render service |
| 8 | [Claude brain, API compute](https://claude.ai/code/artifact/d4f87b7e-9ecf-4984-848c-0a1fa31e2193) | Timeline schema example, Claude role costs | Remotion as primary renderer |
| 9 | [Content Factory master review](https://claude.ai/code/artifact/866b5081-469b-4136-8830-e816bd64dcbe) | master-skills analysis, local-to-API swaps, quality gates | — |

**Repositories:** [Meridian](https://github.com/RTK23-dev/meridian) ([PR #39](https://github.com/RTK23-dev/meridian/pull/39), [PR #45](https://github.com/RTK23-dev/meridian/pull/45)); [Cyclone](https://github.com/RTK23-dev/cyclone-fleet); [master-skills](https://github.com/Jakeschincariol/master-skills), [instagram-agent-skill](https://github.com/Jakeschincariol/instagram-agent-skill), [linkedin-agent-skill](https://github.com/Jakeschincariol/linkedin-agent-skill), [Ness edition](https://github.com/nessalazne/master-skills).

**Pricing and platform sources:** [OpenRouter video models](https://openrouter.ai/collections/video-models), [image models](https://openrouter.ai/collections/image-models), [speech models](https://openrouter.ai/collections/text-to-speech-models); [Claude Opus 5.5 pricing](https://techjacksolutions.com/?p=89318), [Claude Sonnet 5.5 pricing](https://emergent.sh/learn/claude-sonnet-5-5-pricing), [Anthropic API docs](https://docs.claude.com/en/api/overview); [HeyGen API and HyperFrames pricing](https://www.g2.com/articles/heygen-api-pricing), [HyperFrames overview](https://themenonlab.blog/blog/heygen-hyperframes-video-as-code); [Instagram data API prices](https://www.socialcrawl.dev/blog/best-instagram-data-apis-2026); [Instagram Content Publishing docs](https://developers.facebook.com/docs/instagram-platform/content-publishing); [EU AI Act Article 50](https://www.ropesgray.com/en/insights/viewpoints/2026/08/102nfqm/you-talkin-to-me-operationalising-the-eu-ai-acts-transparency-obligations).
