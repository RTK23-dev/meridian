# Credentials

Keys for a workspace are saved in the app, under **Settings**. They are encrypted and are not shown again. The screen shows the last four characters.

Do not put a normal provider key in `.env`. A few values belong to the deployment rather than one workspace. Those stay off until you opt in. The full list is [docs/PROVIDERS.md](../docs/PROVIDERS.md).

## Workspace keys

Save these in Settings for the workspace that will use them:

- Decision engine: TypeSafe JEV, or OpenAI Decisions. One engine receives a decision. There is no silent fallback.
- Image and video providers, including OpenRouter when a model is called through it
- Meta, Google, and TikTok logins for publishing and performance
- Google Drive, for files and exports
- Apify, when Gather should read Instagram volume
- Shopify webhook secret, for order attribution

A provider with no key is **not connected**. The screen says which name is missing.

## Deployment values

These are read from the server environment, and only when the matching opt-in is set. The names are in `.env.example`.

| Value | Opt-in | Used for |
| --- | --- | --- |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | `GOOGLE_ADS_DEVELOPER_TOKEN_SHARED_DEFAULT=deployment` | Google Ads. The customer id still comes from the brand's connected account, not from the environment |
| `DEEPGRAM_API_KEY` | `DEEPGRAM_SHARED_DEFAULT=deployment` | Speech-to-text. A workspace can save its own key instead |
| `APIFY_TOKEN` | `APIFY_SHARED_DEFAULT=deployment` | Instagram volume discovery |

A Google customer id and a TikTok advertiser id are the brand's connected account. They are not environment variables.

## What this release will not guess

These stay unset until you set the number. Meridian does not invent a price.

- HyperFrames, per minute
- Apify, per 1,000 results
- `image.edit`
- The platform file-size limit (`thresholds.render.platformMaxBytes`)

Perception tokens are stored. There is no published price, so their dollar cost stays empty.

## What a live run still needs

The code path exists. It stays not connected until the server has the credential.

- OpenRouter, Deepgram, Drive, and a Hypit process
- Meta, Google, TikTok, and YouTube publishing and performance
- Shopify order webhooks, Apify discovery, and invitation email
