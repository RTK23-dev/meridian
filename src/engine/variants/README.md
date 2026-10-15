# Variants (W13)

Implements Video Engine Bible **section 6.13** (variants) and the cost rules of **14.3** (cost per variant). The handler that runs
it is `src/engine/jobs/handlers/variants.ts`.

## Files

| File | What it does |
| --- | --- |
| `config.ts` | The six attributes (`caption`, `music`, `hook`, `product`, `persona`, `language`) and their fit order, the caption bands the compositor draws, and the music mix a variant uses when the master has no music. The mix mirrors `edit/tuning.ts`, and `expand.test.ts` checks the two agree. |
| `expand.ts` | **Pure.** `expandVariants(input)` turns the matrix into planned variants and skipped ones. Each planned variant records its **control**: the master EDL and the one attribute it changes (`from`, `to`). It also records its work (`produceShotIds`, `voiceBeatIds`, `writerBeatIds`), its build (`rerender` or `generation`) and its estimate. The fit is cheapest first, then the matrix order, and it names the limit that stops a variant: `over_max_variants`, `over_budget` or `over_reservation`. |
| `diff.ts` | **Pure.** `diffEdl(master, variant)` names every changed part of an EDL as a surface (`captions`, `music`, `voice`, `visual:<clip>`, `timing:<clip>`, and so on). `checkControl` refuses a variant whose changes are not the ones its attribute allows. `withCaptionBand`, `withMusic` and `withVisualSources` are the transforms. `buildRerenderVariant` builds a caption or music variant from the master and checks it against its control. `asVariant` gives the variant its own id, with `variantOf` set to the master, and checks it against the EDL contract. |

## The work each attribute needs

| Attribute | Work | Build |
| --- | --- | --- |
| `caption` (a band) | Captions track props. A caption over the presenter keeps the master's band (the face rule, 8.2 step 9). | EDL diff, re-render. No generation. |
| `music` (a track) | `audio.music` under the whole timeline, at the master's mix. | EDL diff, re-render. No generation. |
| `hook` | The writer writes the hook line, the voice stage speaks that beat, and the generated shots in the hook beat are made again. | Generation (not run in the variants stage). |
| `product` | `produce_shot` again for the `product_hero` shots only. | Generation. |
| `persona` | The voice stage speaks every beat, and the presenter shots are made again. | Generation. |
| `language` | The writer writes every beat, the voice stage speaks every beat, and the presenter shots are made again. | Generation. |

Caption and music variants change one surface each, and `checkControl` checks that. Hook, persona and language variants change the
voice and the takes, so the editor rebuilds their EDL from the new inputs; `checkControl` limits what that rebuild may change.

## Rules

- A variant changes one attribute against the master, and the EDL diff shows it. A variant that changes anything else is not built.
- A variant with no change (a caption band the master already has) is not built, and the reason says so.
- The budget is the matrix's `budgetUsd`, or the reservation's headroom when that is lower. Every number is read from
  `config/budgets.ts` (`variantCostUsd`, the high end of each estimate).
- A variant id is a hash of the master EDL and the variant key, so a retried job names the same EDL (Bible 5.1).

## Tests

`NODE_ENV=development node --experimental-strip-types --test 'src/engine/variants/*.test.ts'`. The handler tests (PGlite, with
the artifact store) are in `src/engine/jobs/handlers/variants.test.ts`.

See `STATUS.md` for what is built, what is deferred, and the blockers for the lead.
