# Creative intelligence

What exists:

- Stored creatives carry angle, hook, format, proof, offer, CTA, visual style, platform, emotion, and claim.
- `knowledge/model.ts` queries exact attribute matches and Jaccard similarity.
- `semantic/lexical.ts` hashes tokens and compares them with cosine similarity. Identical stored text against a competitor row is classified `too_close_to_competitor`. That classifier is lexical. It is not a neural embedding.
- `clusterBy` groups stored rows by a field such as angle.
- `whitespaceAngles` lists angles that appear on competitor rows and not on this brand's rows.
- Opportunity ranking keeps one candidate per angle so the same strategy is not repeated once per product.
- A competitor row whose text contains a candidate's own hook line sets `copiesProtectedPhrasing`. The opportunity gate then rejects that candidate.

What does not exist:

- A connected neural embedding provider. Its status is `NOT_CONNECTED`.
- Visual clustering, narrative clustering, or audience clustering beyond the stored attribute fields.
- An ad-library collector. Clusters only contain rows someone stored.

Do not describe lexical similarity as semantic understanding.
