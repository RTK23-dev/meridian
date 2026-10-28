# Owner's product map and stabilization plan

**Audit date:** 2026-10-28  
**Purpose:** Explain what the repository actually contains and define a narrow route toward a stable, usable product.  
**Evidence level:** Source and documentation inspection only. This is not a live browser walkthrough and does not prove that real providers work.

Related work: [issue #83 — Product recovery: make Meridian a clear research-to-batch-video tool](https://github.com/RTK23-dev/meridian/issues/83).

## The plain-English picture

The intended job, as understood from the owner's description, is:

**Use research and reference videos to find a repeatable content format → make many original short videos in that format → review them → export them.**

The current codebase is much broader. It is an advertising operating system for a brand: workspace and brand management, source collection, evidence analysis, decision engines, creative generation, review, library, publishing, ads, results, learning/calibration, account connections, job operations, team roles, audit trails, and spend controls. It also contains a substantial video-engine pipeline. The repository even has a blueprint (`docs/design/KATANA_REDESIGN_PLAN.md`) for five clear places—Home, Create, Library, Insights and Settings—but the live navigation has not been simplified to that map.

That is why it feels like a different product: the interface exposes multiple concepts and workflows before it gets the owner to the single result they care about. The current Content page contains several ways to create. The research-led Factory was hidden behind an admin-only Ads tab, and its initial view opened on a technical Pipeline Editor while the run builder sat under Discover. This change renames the owner-facing tab to Batch, moves it beside Create, makes it the default for admins, and makes its first view Make a batch. The two creative paths—research-led Factory and direct creation from a reference—are still not one guided workflow. The page says this plainly, instead of implying that they are already joined.

This mismatch is not the owner's failure to understand the interface. The product currently asks the owner to learn the software's internal architecture before they can reach the desired outcome.

## What is present in the code

| Area | What exists | What it does not prove |
| --- | --- | --- |
| Workspace and brands | Accounts, workspaces, brand facts, products, roles, audit history | That a brand is configured with the right facts for this owner's actual content |
| Market and research | URL-based collection, source adapters, uploads, stored evidence, analysis and opportunity ranking | That any given social URL is readable, that a blocked source can be reached, or that the desired research source works live |
| Content and Studio | A unified Content page with Create, Ideas, Review, Library, Publish, Results and Batch sections; distinct brief/reference/Studio entry modes; the Batch tab now opens directly on the run builder | That a new user can combine their reference and research in one workflow, or that an end-to-end video can be produced with the current server configuration |
| Research-led Factory | A staged pipeline for gathering, grading, picking, planning, producing, gating, approvals, and learning, with variant and budget concepts | That the whole pipeline has completed a live research-to-many-videos run |
| Video engine | Typed artifacts and staged jobs for reference analysis, script and scene planning, shot production, editing/composition, gates, and output manifests | That the engine has passed a real end-to-end run on paid providers or rendered a usable result for this workspace |
| Publishing and ads | Interfaces and guarded paths for organic posts, paused paid ads, measurements, and repurposing | That publishing, account permissions, billing, metrics or live receipts have been verified |
| Integrations and operations | Provider settings, jobs/health, budgets, safety gates, operations screens and documentation | That a saved key means a live connection is healthy, or that unconnected services are ready |

## What the owner would currently encounter

Paths below are from the route and navigation definitions, not screenshots of a running deployment.

1. **Setup guide** (/setup): workspace-level setup and decision-engine selection.
2. **Brand overview** (/brands/:id): starting point for a particular brand.
3. **Brand brain and Products**: enter brand positioning, audience, tone, prohibited claims and products.
4. **Market** (/brands/:id/market): collect accessible evidence. A URL is not a guarantee that a source will permit automated reading.
5. **Intelligence**: inspect analysis/opportunities.
6. **Content** (/brands/:id/content, or /content-factory): one page with several sections. Create offers multiple entry modes; Ideas, Review, Library, Publish and Results are other tabs. Admins also see Batch, where the research-led Factory lives. Its first tab is now Make a batch; Factory Line, Templates, Production, Review, Live tests and Learnings remain advanced tabs.
7. **Settings, Integrations, Jobs & health**: configure and diagnose the system. They are operational support, not the desired daily creative workflow.

The underlying code also has separate concepts for a decision engine and a video-production provider. The decision engine judges/reasons over inputs; it is not necessarily the system that generates the video. This distinction is technically valid but is too much for the primary user journey.

## What is verified, and what is not

### Verified by repository records

- The latest documented release is v0.1.0-beta.16; its release notes say it is a pre-release and not a stable production release.
- The merged first-run UX change had all 13 required CI jobs pass.
- The tests cover contracts, fixtures/fake transports, seeded local app flows and PostgreSQL behavior.
- The app is explicitly designed to fail closed: missing credentials or an unready provider should say so rather than pretend a job succeeded.

### Not verified in a live environment

- Real provider credentials, paid requests, provider billing, live reference analysis, image/video generation, publishing and performance sync.
- A complete real reference/brief → finished video run, and especially a batch of finished videos.
- A human walkthrough by the owner confirming that the screens are understandable and the output matches the intended Reel.

The root README, docs/ROADMAP.md and docs/engine/PHASE_LOG.md record these limitations. Green CI means the tested code paths passed; it does **not** mean the desired real-world workflow is already working. Do not call this version stable until the live acceptance is recorded.

## The recommended product boundary for the next version

Keep the engineering underneath where useful, but make the main user journey one sequence:

### 1. Start a project
Ask for a brand/product, audience, topic/niche, and one or more reference links or uploads. Say clearly whether a reference was actually read, partly read, blocked, or only provided as a file/text.

### 2. Build a research board
Show the real examples and sources; summarize their structure, hook, pacing, visual approach, and call to action. Separate observed facts from interpretation. Let the person discard examples and approve a format before production.

### 3. Approve one reusable video format
Create the original script/template and show a preview. Reuse the structural pattern, not someone else's footage, script, voice, or music. Allow editing before the batch starts.

### 4. Generate a batch
Let the person choose how many variants, where they differ, and a hard cost limit. Each video must have a truthful status, script, output/preview when complete, cost basis (estimated versus provider-reported), and a reason for any block/failure. Never silently swap to a different provider.

### 5. Review and export
Show videos in a review grid with play, approve, reject, and regenerate actions. Export finished files and associated captions/source/manifest information. Publishing, paid ads, analytics and automated optimization can remain available in secondary areas but must not obstruct making and exporting videos.

## Stabilization gates

A stable release should pass all of these, in this order:

1. **Product gate:** the owner can describe the main workflow after opening the app, without reading repository docs or visiting operations settings.
2. **Fixture gate:** a full research-to-batch scenario is covered with clearly labelled fixtures/demo data; fixture results never masquerade as live generation.
3. **Safety gate:** live actions refuse before any request or spend when credentials, declared price, budget, required storage or review gates are missing.
4. **Browser gate:** a single end-to-end browser walkthrough follows Start → Research → Approve format → Batch → Review → Export and captures screenshots/results on desktop and mobile.
5. **Live gate:** with owner-authorized credentials, record a real input, at least one successfully rendered video and a small batch, output artifact IDs, provider/model, request outcomes and actual costs where reported.
6. **Owner gate:** the owner inspects the outputs and confirms they are close enough to the reference and appropriate to the product before the release is called stable.

Until the live and owner gates pass, the honest label remains **evaluation / beta**, not stable.

## Immediate next step

Work is tracked in [issue #83](https://github.com/RTK23-dev/meridian/issues/83). Freeze expansion of secondary advertising features while choosing and simplifying one end-to-end implementation path. Do not merge another architecture-only change as a substitute for proving the user journey.