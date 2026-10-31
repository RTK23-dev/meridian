# Style presets: `src/engine/presets/`

A style preset is a reusable "make videos in this style" package, built from one reference video and kept as data. It uses the
existing contracts only: the style kit (`styleKitSchema`), a look (`LOOK_PRESETS`) and the genes (`GENE_IDS`). It adds no contract,
so it needs no version bump. Whether presets get fields of their own is the owner's decision Q1 in `.claude/loop/OPEN_QUESTIONS.md`.

## Files

- `style-presets.ts`: the `StylePreset` shape, the registry (`STYLE_PRESETS`), `stylePreset(id)` (an unknown id is refused),
  `presetProblems(preset)` (contract and consistency checks) and `installStylePreset(sql, { organizationId, presetId })`, which writes
  the preset's style kit into one workspace's kit store (`engine_kits`, through `jobs/kit-store.ts`).
- `three-d-data-explainer.ts`: the first preset, the 3D satellite data explainer. Its run report is
  `docs/engine/STYLE_PRESET_3D_DATA_EXPLAINER.md`.
- `style-presets.test.ts`: the contract checks, the kit's CSS, the format id rule and the install on PGlite.

## What a preset holds, and where each part goes

| Part | Used by today | How |
| --- | --- | --- |
| `styleKit` | The compiler (CSS variables), intake, the plan and edit gates | Installed into `engine_kits`; a theme page names its `styleKitId` |
| `reference.formatId` | Intake's Video DNA cache | The Content Factory names a reference `ref_` plus 24 hex of its SHA-256, so the same file gives the same format, and the DNA of the first analysis is reused |
| `look` | The compiler, for repurposed cuts (`visualTreatmentSchema`) | Guidance until a request carries a look for generated cuts |
| `genes.keep` | `format.keep` of a production request | Copied into the request |
| `structure`, `shots`, `grammar` | Nothing reads them yet | Guidance for the planner and for the person writing the brief |
| `gaps` | People | What the preset cannot express or draw today, and what each needs |

## Rules

- Every value says where it came from: measured by the media functions or the engine's analysis code, read from frames outside the
  engine's roles, or chosen to fit a contract. Unknown stays unknown: a field the run did not measure is listed in `grammar.unknown`,
  never filled with a guess.
- Genes, never content: no footage, voice, music, script line or brand of the reference is stored.

## Tests

    NODE_ENV=development node --experimental-strip-types --test src/engine/presets/style-presets.test.ts
