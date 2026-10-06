# AI system

JEV is Meridian's research, reasoning, and decision layer. OpenRouter is the only external model gateway; set both `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`. Without either value, model-backed actions report not configured and do not invent output. No OpenAI or xAI key is required.

## Routing

`src/lib/meridian/providers/chat.server.ts` routes JEV research analysis, typed decisions, briefs, and vision evidence through the configured OpenRouter model. Both `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` are required; Meridian does not select or hard-code a model.

Research audio is transcribed locally by WhisperX after ffmpeg extraction. Configure `WHISPERX_PATH`, `WHISPERX_MODEL`, and `WHISPERX_DEVICE`; missing WhisperX is `NOT_CONNECTED`, not a hosted API fallback.

Google AI Studio / Nano Banana is an optional image tool configured by `GOOGLE_AI_STUDIO_API_KEY`. Without it, optional images are skipped and JEV/Hypit continue. Hypit is the only production video engine.

## Where a model is used

- JEV research analysis, brand-brain suggestions, and structured creative reasoning.
- Vision evidence when an image is explicitly generated and reviewed.

Thresholds, ranking, tenant checks, dedupe, learning math, claim checks, and workflow stages remain deterministic code. External text is untrusted data, and model output is validated before it enters a creative or decision record.
