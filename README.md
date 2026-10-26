# Meridian

Meridian is the operating system for one brand's advertising. You give it the brand. It gathers evidence, decides what is worth making, produces the ads and posts, checks them, and changes the next recommendation after it sees what happened.

It never invents a result. A step with no key, no account, or no bill says so and stores nothing. A person reviews what is made before it goes out, and paid ads are always created paused.

## What it is for

A small team that runs ads for a brand and wants one place where the facts, the evidence, the creative work, the review, and the results stay connected. Each brand has its own research, grades, creatives, receipts and measurements. Nothing crosses from one workspace to another.

## How it works

There are two ways to start, and they share one backend: the same brands, evidence, plans, assets, runs, reviews, publishing receipts, measurements and learning.

- **Research-led.** The factory gathers and grades evidence about the niche, proposes an angle, plans, produces, checks, and asks for approval.
- **Direct.** You bring a brief, a reference video, or your own upload, and the Content page plans, generates, revises and reviews it.

The loop, in either case:

1. **Brand.** Positioning, customers, tone, claims, and products.
2. **Evidence.** Pages, ads, and uploads the brand is allowed to use.
3. **Decision.** The decision engine answers a fixed set of questions from that evidence. It does not invent the evidence.
4. **Brief.** An approved decision becomes a creative brief.
5. **Make.** Images go to the image provider configured for the workspace. Video can go to Gemini Omni, Higgsfield, or a manual cloud folder. Hypit is not connected to production routing: it refuses every job until its runtime is connected and licensed (docs/HYPIT_LICENSE.md). If the chosen provider is not connected, the job says so and nothing is sent.
6. **Check.** Claims, brand rules, rights, and a human review. A missing piece of evidence goes to review. It is never passed.
7. **Publish.** Organic posts go to a connected account. Paid ads are created paused, and Meridian has no button that turns them on. A delivered video can also be repurposed into reviewed variations, and each step (library, upload, paused ad, Facebook post, metrics) is a separate action; see docs/FACTORY.md.
8. **Learn.** Measured results are stored only when they were observed, and the next brief can change.

## The screens

| Screen | What it is for |
| --- | --- |
| **Setup guide** | A short path: create a brand, choose a decision engine and save its key. Optional connections sit behind "Open this step" |
| **Content** | One page per brand. Create, Ideas, Review, Library, Publish, Results and Ads are its sections. Create starts a session from a brief, a reference, or Studio; the run planner is one click away under "Plan a run in detail" |
| **Integrations** | Every connection, with what it needs and its state |
| **Jobs & health** | Queued work, the worker and the scheduler |
| **Settings** | The workspace, its members, scoring weights, alerts, learning, and the uncertain model-call holds |

## What it will not do

These rules hold across the code, and tests enforce them.

- **Fail closed.** Unknown stays unknown. A service that is not connected returns NOT_CONNECTED, never success. A saved key reads "Saved, not checked live"; only a recorded successful provider request makes a connection healthy, and only for a day.
- **No fake success.** No invented costs, metrics, ads, receipts or connected states.
- **Spending is bounded.** Every paid model call is held in a ledger before it is sent, against a monthly budget that is a hard limit. A call whose outcome is unknown keeps its hold and is not retried until an administrator releases it, with a reason, in an audited step.
- **Unsafe paths are off.** Twenty paid or side-effecting paths stay disabled until they have an idempotency guard and a test: they refuse before any request is made, and they are never retried. The list and the reasons are in [docs/OUTBOUND_REQUESTS.md](docs/OUTBOUND_REQUESTS.md).
- **Outputs are data.** Source text, ad text, transcripts, fetched pages and provider outputs are validated and never executed or passed on as instructions.
- **Roles and tenancy.** Owners and admins change settings, keys and brands. Members create and review. Viewers read. Every mutation checks the role on the server, and every server function checks the workspace.
- **Secrets stay secret.** Keys are encrypted on the server, shown by their last characters only, and never logged.

## Run it on your machine

You need Node.js 22. You do not need API keys to start.

```bash
npm run dev
```

The first run installs dependencies, creates `.env`, and starts the app at http://127.0.0.1:8080. The database is an embedded Postgres file in `.data/pglite`. Accounts survive a restart. Queued jobs run inside this same process.

Then:

1. Open the app and choose **Create an account instead**.
2. Create a workspace, then a brand.
3. Follow the **Setup guide**. The required steps are a brand and a decision engine.
4. Fill the brand brain. The required fields are positioning, target customers, tone, and prohibited claims.
5. Add provider keys later, when you have them.

`npm run setup` does the `.env` step on its own and is safe to run again.

## Run it on a server

Set `DATABASE_URL` to PostgreSQL 16. Run the app, `npm run worker`, and `npm run scheduler` as separate processes. Production fails closed without `DATABASE_URL`. Docker Compose is in [docs/SETUP.md](docs/SETUP.md).

Keys for a workspace are saved in the app. A few values belong to the deployment rather than a workspace, such as the Google Ads developer token. Those are off until you opt in. The names and the switches are in [docs/PROVIDERS.md](docs/PROVIDERS.md) and [.env.example](.env.example).

## Where it stands

This is a pre-release, `0.1.0-beta.16`. Everything was checked with fixtures, fake transports, a seeded local app and PostgreSQL in CI. **No live provider run is recorded.** Live provider behavior, real credentials, billing and publishing are unverified until the keys are on the server and someone runs them.

What still needs a key or a decision. The code path exists, and it stays not connected until the server has the credential or you set the number:

- Live image and video calls, including OpenRouter, Deepgram, Drive, and a Hypit process
- Live publishing and performance for Meta, Google, TikTok, and YouTube
- Shopify order webhooks, Apify discovery, and invitation email
- Prices Meridian will not guess: HyperFrames per minute, Apify per 1,000 results, and `image.edit`

OpenRouter does not state a billing rule for a request that errors or times out, so such an outcome is treated as possibly billed. This is a documented limitation ([docs/OPENROUTER.md](docs/OPENROUTER.md)).

A stored grade is not rewritten when calibration changes. The next run grades the ad again.

## Repository layout

| Path | What is in it |
| --- | --- |
| `src/routes/` | The screens (file-based routing) |
| `src/components/` | The interface and the design system in `src/components/ui/` |
| `src/lib/meridian/` | Domain logic and server functions |
| `src/lib/meridian/factory/` | The research-led factory pipeline |
| `src/engine/` | The video engine. Its specification is `docs/engine/VIDEO_ENGINE_BIBLE.md` |
| `migrations/` | SQL, applied in filename order |
| `scripts/` | Setup, the worker and scheduler, and the browser checks |

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | First-run setup, then the app on port 8080 |
| `npm run setup` | Create `.env` and generate secrets. Safe to repeat |
| `npm run worker` | Queued jobs, when `DATABASE_URL` is set |
| `npm run scheduler` | Periodic work, when `DATABASE_URL` is set |
| `npm run db:migrate` | Apply SQL migrations |
| `npm test` | Unit and integration tests |
| `npm run typecheck` | Typecheck |
| `npm run lint` | Lint |
| `npm run build` | Production build |
| `npm run e2e` | The product loop in a browser |

## How it is checked

CI runs the tests in six shards, typecheck, lint and build, the sourcing sidecar's tests, the money checks on a real PostgreSQL server, a browser acceptance of the Settings screens, the UI baseline and accessibility checks, and the product-loop end to end. The `check` job requires all of them, and it fails if any was skipped. No test calls a live provider. See [docs/TESTING.md](docs/TESTING.md) and [docs/RELEASE_ACCEPTANCE.md](docs/RELEASE_ACCEPTANCE.md).

## Documentation

| Document | Read it for |
| --- | --- |
| [docs/SETUP.md](docs/SETUP.md) | Install, environment, Drive, deploy |
| [docs/PRODUCT.md](docs/PRODUCT.md) | The product workflow |
| [docs/FACTORY.md](docs/FACTORY.md) | The factory pipeline and the Content page |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | Every provider and where its key goes |
| [docs/OUTBOUND_REQUESTS.md](docs/OUTBOUND_REQUESTS.md) | Every path that can make a request, and how it is guarded |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Processes, health, backups |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What is still open, and why |
| [docs/README.md](docs/README.md) | The full document index |
| [wiki/Home.md](wiki/Home.md) | The same guide, as wiki pages: setup, the loop, and credentials |
