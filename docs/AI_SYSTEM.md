# AI system

No model is called in this version. There is no provider key in source, and missing providers are not replaced with sample output.

## What is real today

`src/lib/meridian/scoring.ts` scores an opportunity from structured inputs and stored weights:

```
brand fit + historical evidence + market signal + novelty + reproducibility − saturation − risk
```

Inputs are clamped to 0–1. The function returns the raw weighted sum and a 0–1 normalization used only for ranking. It does not invent evidence. The overview does not display a score, because there are no candidates.

Brand completeness counts non-empty fields a person wrote. An empty brain is incomplete, not “understood by AI.”

## Rules for the next AI slice

- Server-only adapter. The UI asks to “understand the brand” or “check the creative,” not to run a pipeline by name.
- Structured output validated before it is stored.
- Suggestions stay `ai_inferred` until a person accepts them. Acceptance rewrites provenance to `user_defined`.
- Retrieved brand facts only. Do not paste the whole library into a prompt.
- External sites and uploads are data, delimited from system instructions.
- Log provider, model, latency, and failure. Do not log secrets.
- If the provider is not configured, the screen says that. It does not render a fake asset.
