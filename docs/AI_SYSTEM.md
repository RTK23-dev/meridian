# AI system

Models are optional. If neither `XAI_API_KEY` nor `OPENROUTER_API_KEY` is set, generation and brain suggestions return "not configured". They do not invent copy.

## Routing

`src/lib/meridian/providers/chat.server.ts`

- xAI (`grok-4.5`) when `XAI_API_KEY` is present
- otherwise OpenRouter when `OPENROUTER_API_KEY` is present, model from `OPENROUTER_MODEL` or `openai/gpt-4.1-mini`
- otherwise no provider

Image generation is xAI Imagine only, and only after a person presses Generate image. The image URL is then sent to a vision-capable chat model, which must return structured evidence. JEV scores that evidence and never receives the pixels. If the model is not configured, or the JSON is unusable, visual QA stays in human review and does not invent a score.

## Where a model is used

- Suggest brand-brain fields from a stored page. Suggestions are pending until accepted. Acceptance is stored as written by the person.
- Draft a script from the brief's retrieved context.

## Where a model is not used

Thresholds, ranking, tenant checks, dedupe, learning math, claim checks, and workflow stages.

## Prompts

`src/lib/meridian/prompts/registry.ts` versions `creative_script` and `brain_suggest`. Each model call writes `model_runs` with provider, model, prompt id, version, latency, token count when the provider returns it, status, and correlation id. The API key is not written.

External text is placed inside `<untrusted_source>` tags. The system prompt says that content is data.

## Structured output

Script generation must parse to hook, script, offer, CTA, visual treatment, and claims. A non-JSON reply is a failed job, not a creative.
