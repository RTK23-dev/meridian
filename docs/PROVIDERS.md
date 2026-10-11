# Providers and keys

Provider keys belong to a workspace. A key is saved in Settings, encrypted, and used only for that workspace. A deployment may
also supply a key for everyone, but only when an operator opts in with the variable named below. See ARCHITECTURE_CONTRACTS.md,
section 1, for the rules.

## Per-workspace provider keys

| Provider | Used for | Saved in Settings | Deployment key (opt-in) | Without a key |
| --- | --- | --- | --- | --- |
| TypeSafe JEV | Decisions (the JEV engine) | JEV | `TYPESAFE_JEV_API_KEY` or `TYPESAFE_API_KEY`, with `JEV_SHARED_DEFAULT=deployment` | Not configured. No decision is made |
| OpenAI | Decisions (the OpenAI engine) | OpenAI | `OPENAI_API_KEY`, with `OPENAI_SHARED_DEFAULT=deployment` | Not configured. No decision is made |
| Gemini perception | Reading images and video | Perception | Google key aliases in `config/resolver.ts`, with `PERCEPTION_SHARED_DEFAULT=gemini` | Not configured |
| Gemini production | Omni video and image generation | Production | `MERIDIAN_GEMINI_API_KEY` or the Google aliases, with `PRODUCTION_SHARED_DEFAULT=deployment` | Not configured. Nothing is generated |
| Higgsfield | Video generation | Production | `HIGGSFIELD_API_KEY`, with `PRODUCTION_SHARED_DEFAULT=deployment` | Not configured |
| Hypit | Video runtime | Hypit | `HYPIT_API_TOKEN` or `HYPIT_API_KEY`, with `HYPIT_SHARED_DEFAULT=deployment` | Not connected. Set `HYPIT_BASE_URL` for the runtime itself |

Sources keep one key per connector. Each has its own opt-in, named `<CATEGORY>_SHARED_DEFAULT`:

| Source | Environment names (first one set wins) | Opt-in |
| --- | --- | --- |
| Meta Ad Library | `META_AD_LIBRARY_TOKEN` | `META_AD_LIBRARY_SHARED_DEFAULT` |
| Meta Graph | `META_ACCESS_TOKEN`, `FACEBOOK_ACCESS_TOKEN` | `META_GRAPH_SHARED_DEFAULT` |
| Instagram | `INSTAGRAM_ACCESS_TOKEN` | `INSTAGRAM_SHARED_DEFAULT` |
| YouTube | `YOUTUBE_API_KEY` | `YOUTUBE_SHARED_DEFAULT` |
| Search | `SERPAPI_API_KEY`, `GOOGLE_SEARCH_API_KEY` | `SEARCH_SHARED_DEFAULT` |
| X (Twitter) | `TWITTER_BEARER_TOKEN`, `X_API_KEY` | `TWITTER_SHARED_DEFAULT` |
| LinkedIn | `LINKEDIN_ACCESS_TOKEN` | `LINKEDIN_SHARED_DEFAULT` |
| Pinterest | `PINTEREST_ACCESS_TOKEN` | `PINTEREST_SHARED_DEFAULT` |
| TikTok | `TIKTOK_ACCESS_TOKEN` | `TIKTOK_SHARED_DEFAULT` |
| Licensed data | `LICENSED_DATA_API_KEY`, `SENSOR_TOWER_API_KEY` | `LICENSED_SHARED_DEFAULT` |

A source with no usable key is listed as not configured, with the reason. Public web pages need no key.
Reddit's API is not connected in this release; direct post URLs are still read from their public pages.

OpenRouter is used only for copy generation, and only from the deployment: `OPENROUTER_API_KEY`, with
`OPENROUTER_SHARED_DEFAULT=deployment`. It is never a decision engine.

## Infrastructure (environment only)

These are read by the code that owns them. They are not saved per workspace.

- `TOKEN_ENCRYPTION_KEY`: encrypts saved keys and connection tokens. Losing it makes saved keys unreadable.
- `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`: sign-in.
- `DATABASE_URL`: PostgreSQL.
- `S3_*`: optional object storage for artifacts.
- `EMAIL_API_URL`, `EMAIL_API_KEY`: optional email delivery.
- `WEBHOOK_SECRET`: the secret that inbound webhooks are checked against.
- `EXTERNAL_SEMANTIC_URL`, `EXTERNAL_SEMANTIC_KEY`: optional external embeddings. Without them, the local semantic store is used.
- `GOOGLE_SERVICE_ACCOUNT_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `MERIDIAN_DRIVE_FOLDER_ID`: Google Drive.

## Deployment configuration

Non-secret settings: `HYPIT_BASE_URL`, the model names (`MERIDIAN_OMNI_MODEL`, `MERIDIAN_IMAGE_MODEL`, `OPENAI_DECISIONS_MODEL`,
`TYPESAFE_JEV_MODEL`), timeouts, and the Cyclone device gateway (`CYCLONE_GATEWAY_URL`, `CYCLONE_DEVICE_ID`, `CYCLONE_API_KEY`).
Cyclone is one device owned by the deployment, so its key is read from the environment by design.

## Engine choice

Decisions use one engine per workspace (DECISIONS.md). `DECISION_ENGINE` sets the deployment default. A workspace's own choice,
made in Settings, takes precedence.
