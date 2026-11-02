# Meridian prices, as data

These files hold every price Meridian has, so they can be read without running the app, and so research can use them. They are
generated from the code and the snapshot; do not edit them by hand. Regenerate with `npm run prices:export`. A test fails if they drift.

A price that is not known is written as `unknown`. It is never written as 0.

## The files

- `engine-prices.csv` and `engine-prices.json`: the video engine's price table. Each row has a key, its unit, its price in US dollars
  and the source of the price. Sources: `list_oct_2026` (a list price checked for this table), `openrouter_listing` (read from
  OpenRouter's public listing) and `third_party_unverified` (not checked against the vendor's own page).
- `token-rates.csv`: the Claude token rates, in US dollars per million tokens.
- `factory-token-prices.csv`: the Factory's published token prices for the decision model, with the page each was read from and the date.
- `openrouter-listing-2026-10-20.csv`: every model in the OpenRouter listing snapshot taken on 2026-10-20
  (585 entries). Prompt and completion prices are per million tokens. Image and per-second video prices are in US dollars.

## What is not known

The engine price table has 9 keys with no price: `i2v_pinned_model`, `nano_banana_2`, `gpt_image_2`, `stt_vendor`, `lipsync_vendor`, `background_removal_vendor`, `upscaling_vendor`, `render_hyperframes_cloud`, `render_remotion_lambda`. The HyperFrames cloud render price
(`render_hyperframes_cloud`) is one of them. Our data does not contain it, so it is not guessed here.
