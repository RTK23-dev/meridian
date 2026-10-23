# model_brief@1

Stage: plan, a reference for the orchestrating model (owner direction 2026-10-23, B4). Dated 2026-10-23. Read it with the candidate list in the user message. The candidate list is the live catalog and decides what exists: use only an id from it.

## How to read it

- Each class lists the models the engine can price from the public listing. A model with a sourced quality note comes first; the rest follow, newest first. The price basis is the one the engine uses: per token for text and speech, per image for images, per second at 1080p for video. Prices are USD, as listed on 2026-10-23.
- Name an older model only where it is clearly cheaper and the newer one would not fit the step's allowance. Otherwise prefer the newest.
- A quality note is a dated, named source, or the word "unverified". "Vendor claim" and "secondary" say whose report it is. A quality claim without a source is not made.
- A listed price of 0 means the listing gives no cost. Check it before you rely on a step that uses it.
- Video: the engine prices a video step only from a per-second USD price at 1080p. Four models are priced now. Most of the newest video models have no such price and are not usable yet.
- Veo (google/veo) is switched off by the workspace's model policy by default, so it is not listed.

## Text: analysis and script steps

Quality reference: Artificial Analysis Intelligence Index, snapshot 17 October 2026, as reported by Developers Digest (secondary; check artificialanalysis.ai): Claude Opus 5.5 (max with fallback) 58, Claude Sonnet 5.5 56. Source: https://www.developersdigest.tech/benchmarks/artificial-analysis

| Model | Listed | Price basis (USD per token, input / output) | Quality |
|---|---|---|---|
| anthropic/claude-opus-5.5 | 2026-09-22 | 0.000004 / 0.00002 | Index 58, secondary, 17 Oct 2026 |
| anthropic/claude-sonnet-5.5 | 2026-09-28 | 0.000002 / 0.00001 | Index 56, secondary, 17 Oct 2026 |
| minimax/minimax-m3.1-flash | 2026-10-19 | 0.00000015 / 0.0000006 | unverified |
| deepseek/deepseek-v4.1-flash-1017 | 2026-10-17 | 0.0000003 / 0.0000012 | unverified |
| google/gemini-4-argon | 2026-10-13 | 0.000002 / 0.00001 | unverified |
| anthropic/claude-haiku-5.5 | 2026-10-07 | 0.0000001 / 0.0000005 | unverified |
| mistralai/mistral-large-4-0 | 2026-10-06 | 0.00000136 / 0.00000418 | unverified |
| openai/gpt-6.1-sol-pro | 2026-09-29 | 0.000002 / 0.00001 | unverified |
| qwen/qwen3.8-max-prime | 2026-09-23 | 0.000004 / 0.000012 | unverified |
| z-ai/glm-5.3-prime | 2026-09-23 | 0.0000028 / 0.0000088 | unverified |
| x-ai/grok-4.7 | 2026-09-21 | 0.000002 / 0.000006 | unverified |
| moonshotai/kimi-k3 | 2026-07-16 | 0.000000239 / 0.000011936 | unverified |

## Image: visual steps

Quality reference: a text-to-image leaderboard snapshot from June 2026, reported by fal.ai, which sells the same models (vendor-affiliated, secondary): GPT Image 2 (high) about 1338 Elo, Nano Banana 2 about 1260. Source: https://fal.ai/learn/tools/best-text-to-image-apis-2026. Neither id is priced by the engine from this listing: openai/gpt-image-2 has no per-image price, and google/gemini-nano-banana-2 is not in the listing. Neither is usable yet.

| Model | Listed | Price basis (USD per image) | Quality |
|---|---|---|---|
| qwen/qwen-image-2.1-turbo | 2026-10-16 | 0 in the listing: check the cost | unverified |
| qwen/qwen-image-2.1-pro | 2026-10-16 | 0 in the listing: check the cost | unverified |
| krea/k3-edit | 2026-10-15 | 0.02 | unverified |
| bytedance-seed/seedream-5-0-flash | 2026-10-01 | 0 in the listing: check the cost | unverified |
| bytedance-seed/seedream-5-0-lite | 2026-08-13 | 0 in the listing: check the cost | unverified |
| bytedance-seed/seedream-5-0-pro | 2026-08-12 | 0.003 | unverified |
| x-ai/grok-imagine-image-2.0 | 2026-08-11 | 0.01 | unverified |
| qwen/qwen-image-3 | 2026-08-05 | 0.003 | unverified |

## Speech: voice steps

Quality reference: the Artificial Analysis speech board as of late July 2026, as reported in a vendor's release (vendor claim): Speechify's Simba 3.2 first. Source: https://smb.oxfordeagle.com/article/Speechifys-Simba-32-Ranks-1-on-Independent-Artificial-Analysis-TTS-Leaderboard-Worlds-Best-Real-Time-Voice-Model-Above-ElevenLabs-OpenAI-Google-DeepMind-andamp-Others/6a4d33c21f33de42266d6b48. The same report puts Qwen-Audio-3.0-TTS-Plus and Gemini 3.1 Flash TTS close behind (secondary). The top two were about two Elo points apart in a May write-up. Simba 3.2 is not in the engine catalog. Gemini 3.1 Flash TTS is not in the engine catalog under that name; the priced google/gemini-3.8-flash-lite-tts is a different model and is unverified.

| Model | Listed | Price basis (USD per token; the engine counts three characters per token) | Quality |
|---|---|---|---|
| qwen/qwen-audio-3.0-tts-plus | 2026-07-23 | 0.00002 | close behind the leader, late July 2026, secondary: https://smb.oxfordeagle.com/article/Speechifys-Simba-32-Ranks-1-on-Independent-Artificial-Analysis-TTS-Leaderboard-Worlds-Best-Real-Time-Voice-Model-Above-ElevenLabs-OpenAI-Google-DeepMind-andamp-Others/6a4d33c21f33de42266d6b48 |
| mistralai/voxtral-mini-tts-3-0 | 2026-10-20 | 0.000013 | unverified |
| heygen/heygen-voice-1 | 2026-10-13 | 0.000015 | unverified |
| heygen/heygen-voice-1-turbo | 2026-10-13 | 0.000004 | unverified |
| fish-audio/drama-3 | 2026-10-13 | 0.000002 | unverified |
| elevenlabs/eleven-v4 | 2026-10-07 | 0.00008 | unverified |
| elevenlabs/eleven-v4-turbo | 2026-10-07 | 0.00004 | unverified |
| qwen/qwen-audio-3.0-tts-flash | 2026-07-23 | 0.000015 | unverified |

## Video: video and avatar steps

No video quality source was confirmed for this brief. The Artificial Analysis video board is the reference to check (https://artificialanalysis.ai/). Every video quality note here is unverified, except where a source is named.

| Model | Listed | Price basis (USD per second at 1080p) | Quality |
|---|---|---|---|
| alibaba/happyhorse-1.0 | 2026-06-24 | 0.1694 | LMArena board, 1,435 as of 12 May 2026, secondary: https://www.datalearner.com/en/leaderboards/external/video-generation?isChina=1 |
| alibaba/wan-3.0-prime | 2026-08-27 | 0.28 | unverified |
| alibaba/wan-3.0 | 2026-08-24 | 0.20 | unverified |
| alibaba/happyhorse-1.1 | 2026-06-24 | 0.1278 | unverified |

Not usable yet: most of the newest video models in the listing. The engine reads only a per-second USD price at 1080p, so a model priced in cents, per token, per generation, or at another resolution is not priced. Examples: x-ai/grok-imagine-video-1.5-lite, heygen/heygen-video-1, minimax/hailuo-3-max, bytedance/seedance-2.0-mini, runway/gen-4.5.

## What this brief does not decide

- Which model is best for a given step. The plan decides, inside the budgets it is given.
- Any quality claim beyond the sources named above. Every other quality note is unverified.
