# Opportunity engine

The engine answers "what should this brand make next?" from stored evidence. It does not jump from an empty market to a generated ad.

Code: `src/lib/meridian/opportunity/catalog.ts` and `src/lib/meridian/opportunity/engine.ts`.

## Hypotheses are not findings

Six angles are a fixed catalog: demonstration, curiosity, testimonial, offer, comparison, objection. They are strategy shapes. A card is labeled **Hypothesis** until competitor observations or a learned performance pattern exist. The reason text says when market signal was left at zero.

## Inputs

- Brand brain text, as keyword overlap. A brain under 20 characters cannot score brand fit above 0.10.
- Products. Missing product lowers reproducibility.
- Competitor creative rows. Market signal is the share of stored observations using that angle. Saturation is that share only when at least three observations exist.
- Learned CTR patterns. Positive lift is historical support. Negative lift adds risk and adds no support. No pattern means historical evidence is 0, not a neutral 0.5 that would look like data.
- Rejection counts. Two or more unsupported, prohibited, or too-aggressive rejections raise risk on high-claim angles.
- Workspace weights from Settings. The arithmetic is `opportunityScore` in `src/lib/meridian/scoring.ts`.

## Output

Each draft has component scores, a normalized expected value, a confidence that shrinks when the brain, the market sample, or the learning sample is thin, evidence lines, and supporting creative ids.

JEV `opportunity_gate.v2` does not read the rank score. It evaluates competitive strength, brand fit, historical support, risk, and reproducibility from the same stored counts, then applies thresholds. Rejected rows stay visible. Open rows with a review hold cannot be briefed until a person clears them.

Candidates are the six priors plus any angle that actually appears on a stored competitor creative or in a positive learned pattern. A prior with no matching rows is labeled as a prior. Missing market or performance evidence stays at zero.

Refreshing deletes only `open` rows and their open reviews. Briefed and dismissed rows stay.
