# Documentation

Start with the [README](../README.md) for what Meridian is and what runs today. These documents go deeper.

| Document | Read it for |
| --- | --- |
| [NORTH_STAR.md](NORTH_STAR.md) | Read first: the goal, the owner's decisions, the Content Factory plan and the work queue |
| [SETUP.md](SETUP.md) | Installing, the first run, saving keys, connecting Drive, deploying |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the pieces fit: screens, server functions, storage, workers |
| [ARCHITECTURE_CONTRACTS.md](ARCHITECTURE_CONTRACTS.md) | The numbered rules the code refers to in its comments |
| [PROVIDERS.md](PROVIDERS.md) | Every provider, where its key is saved, and the deployment opt-ins |
| [DECISIONS.md](DECISIONS.md) | Decision engines, the policy gate, approval and calibration |
| [FACTORY.md](FACTORY.md) | The Content Factory pipeline as built, and the Content Factory page (`/content-factory`) for starting a video from a chat: run settings, the automation modes and where they stop, approving a stage, spend caps and the kill switch, what grading uses, Gather (including Instagram volume through Apify), the video engine as a producer, publishing and trial reels, theme pages, Shopify attribution and sleep mode |
| [PRODUCT.md](PRODUCT.md) | The workflow from brand brain to publishing and learning |
| [OPERATIONS.md](OPERATIONS.md) | Processes, health, backups, exports and troubleshooting |
| [TESTING.md](TESTING.md) | Test commands, the CI jobs and the browser checks |
| [ROADMAP.md](ROADMAP.md) | What is not built yet, stated plainly |
| [REVAMP.md](REVAMP.md) | The setup guide, sourcing rules (robots, bot checks), paused Meta ads and the design pass, with the decisions made for the owner |
| [AGENT_REACH.md](AGENT_REACH.md) | The optional operator research tool: how to run its check, what Meridian does not do with it, and the risks the operator accepts |
| [SOURCING_SIDECAR.md](SOURCING_SIDECAR.md) | The local sidecar that parses public pages with the vendored Scrapling parser and reads Agent Reach's public channels, and where its boundary is enforced |
| [engine/VIDEO_ENGINE_BIBLE.md](engine/VIDEO_ENGINE_BIBLE.md) | The video engine's specification: scope, the data contracts (section 4, with the v1 to v5 migration notes), stages and gates, and the acceptance tests for each phase (section 19) |
| [engine/MERIDIAN_HANDOFF.md](engine/MERIDIAN_HANDOFF.md) | The handoff plan for the Content Factory: the locked decisions, the build phases and each task's status, the working rules and the open decisions |
| [engine/PHASE_LOG.md](engine/PHASE_LOG.md) | The dated record of the video engine's phases: merges, gates, owner decisions, checks run and the items still open |
| [engine/CHECKPOINT_2026-10-17_final.md](engine/CHECKPOINT_2026-10-17_final.md) | The latest checkpoint: what is on `main`, what is verified and what is not, and the owner decisions still open |
| [engine/PROVIDER_APIS.md](engine/PROVIDER_APIS.md) | The request and response shapes the engine's adapters follow, from each provider's documentation, with the date read. Anything not listed is unknown |
| [feature-screens/README.md](feature-screens/README.md) | Before and after screenshots of the changed screens (theme pages, the Factory run builder, Sales by reel, sleep mode, Settings setup), and what could not be captured |

