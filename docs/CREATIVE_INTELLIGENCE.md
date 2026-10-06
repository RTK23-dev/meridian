# Creative intelligence

What exists:

- Stored creatives carry angle, hook, format, proof, offer, CTA, visual style, platform, emotion, and claim.
- `knowledge/model.ts` queries exact attribute matches and Jaccard similarity.
- `semantic/lexical.ts` hashes tokens and compares them with cosine similarity. Identical stored text against a competitor row is classified `too_close_to_competitor`. That classifier is lexical. It is not a neural embedding.
- `clusterBy` groups stored rows by a field such as angle.
- `whitespaceAngles` lists angles that appear on competitor rows and not on this brand's rows.
- Opportunity ranking keeps one candidate per angle so the same strategy is not repeated once per product.
- A competitor row whose text contains a candidate's own hook line sets `copiesProtectedPhrasing`. The opportunity gate then rejects that candidate.
- JEV Research collects available Meta Ad Library video ads, stores verified source media and timestamped transcripts, and records typed analysis with field-level evidence and confidence. Aggregated patterns enrich opportunities; observed frequency is not treated as effectiveness.

What does not exist:

- Visual, narrative, or audience clustering beyond the stored structured research and creative attributes.

Research collection still depends on Meta Ad Library credentials, accessible downloadable source media, local WhisperX, and OpenRouter configuration. Missing inputs remain unavailable or `NOT_CONNECTED`; Meridian does not fabricate a transcript or ad outcome.

Do not describe lexical similarity as semantic understanding.
