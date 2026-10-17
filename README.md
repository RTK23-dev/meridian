# Meridian

Meridian is the operating system for a brand's advertising. You give it the brand. It gathers evidence, decides what is worth making, produces the ads, and changes the next recommendation after it sees what happened.

It does not invent a result. A step with no key, no account, or no bill says so and stores nothing.

## The loop

1. **Brand.** Positioning, customers, tone, claims, and products.
2. **Evidence.** Pages, ads, and uploads the brand is allowed to use.
3. **Decision.** JEV answers a fixed set of questions from that evidence. It does not invent the evidence.
4. **Brief.** An approved decision becomes a creative brief.
5. **Make.** Images go to the image provider configured for the workspace. Video can go to Gemini Omni, Hypit, Higgsfield, or a manual cloud folder. Hypit is a separate process. If the chosen provider is not connected, the job says so and nothing is sent.
6. **Check.** Claims, brand rules, and a review.
7. **Publish.** Organic posts go to a connected account. Paid ads are created paused. Meridian does not turn them on.
8. **Learn.** Measured results are stored and the next brief can change.

## Run it on your machine

You need Node.js 22. You do not need API keys to start.

```bash
npm run dev
```

The first run installs dependencies, creates `.env`, and starts the app at http://127.0.0.1:8080. The database is an embedded Postgres file in `.data/pglite`. Accounts survive a restart. Queued jobs run inside this same process.

Then:

1. Open the app and choose **Create an account instead**.
2. Create a workspace, then a brand.
3. Fill the brand brain. The required fields are positioning, target customers, tone, and prohibited claims.
4. Add provider keys later, in **Settings**, when you have them.

`npm run setup` does the `.env` step on its own and is safe to run again.

## Run it on a server

Set `DATABASE_URL` to PostgreSQL 16. Run the app, `npm run worker`, and `npm run scheduler` as separate processes. Docker Compose is in [docs/SETUP.md](docs/SETUP.md).

Keys for a workspace are saved in the app. They are encrypted and are not shown again. A few values belong to the deployment rather than a workspace, such as the Google Ads developer token. Those are off until you opt in. The names and the switches are in [docs/PROVIDERS.md](docs/PROVIDERS.md) and [.env.example](.env.example).

## What still needs a key or a decision

The code path exists. It stays not connected until the server has the credential or you set the number.

- Live image and video calls, including OpenRouter, Deepgram, Drive, and a Hypit process
- Live publishing and performance for Meta, Google, TikTok, and YouTube
- Shopify order webhooks, Apify discovery, and invitation email
- Prices Meridian will not guess: HyperFrames per minute, Apify per 1,000 results, and `image.edit`

A stored grade is not rewritten when calibration changes. The next run grades the ad again.

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

## Documentation

| Document | Read it for |
| --- | --- |
| [docs/SETUP.md](docs/SETUP.md) | Install, environment, Drive, deploy |
| [docs/PRODUCT.md](docs/PRODUCT.md) | The product workflow |
| [docs/FACTORY.md](docs/FACTORY.md) | The factory pipeline and the content factory page |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | Every provider and where its key goes |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Processes, health, backups |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What is still open, and why |
| [docs/README.md](docs/README.md) | The full document index |
| [wiki/Home.md](wiki/Home.md) | The same guide, as wiki pages: setup, the loop, and credentials |

This release is `0.1.0-beta.13`. Tests cover the product loop with fixtures. A live provider run is recorded only after the keys are on the server.
