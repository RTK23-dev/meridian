# Preset model: inventory and proposal

Status: proposal, written by the coding loop as task T10 of `.claude/loop/RUN_PLAN.md`. It changes no code. Every reference below was read from the file at the commit it was written on. The open decision it depends on is Q1 in `.claude/loop/OPEN_QUESTIONS.md`.

## 1. What counts as a preset here

A preset is a named choice that a person or a request makes from a fixed set, and that the engine turns into a value it draws. Four families are presets. Two more look like presets but are not chosen by anyone.

| Family | Where it is defined | Options today | Consumer | Contract |
| --- | --- | --- | --- | --- |
| Look | `LOOK_PRESETS` in `src/engine/contracts/edl.ts:17`; overlay table `LOOK_OVERLAY` in `src/engine/compose/compiler.ts:48` | `warm`, `cool`, `faded`, `mono` | `visualTreatmentSchema` (`edl.ts:25`), read at `compiler.ts:333` | The option list is a zod enum, so a new look is a contract change |
| Repurpose option | `OPTIONS` in `src/engine/repurpose/catalog.ts`, one entry per option | 13 available, in five categories (below) | The visual treatment of a repurposed cut | Catalog-only if the option sets a field that already exists |
| Caption style | `CAPTION_COMPONENTS` in `src/engine/contracts/kits.ts` | `captions.karaoke`, `captions.boxed`, `captions.minimal` | The component library | Contract enum |
| Style kit | `styleKitSchema` in `src/engine/contracts/kits.ts:16`; applied by `src/engine/compose/styleKit.ts` | One kit per page: five palette colours, three fonts, a motion level | Injected as CSS variables on `:root` | Contract schema; kits are stored in `engine_kits` (`src/engine/jobs/kit-store.ts`) |
| Editor tuning | `config/thresholds.ts` (`thresholds@3`, `editor` section, `thresholds.ts:10`); `EDIT_TUNING` in `src/engine/edit/tuning.ts:7` | The caption bands, the build steps, the drawable transitions (`hard`, `fade`, `whip`) and effects (`punch_in`, `shake`, `flash`) | The editor and the compiler | Configuration (Bible 16.2), not a contract |

Two things look like presets and are not:

- **Edit grammar** (`src/engine/edit/grammar.ts`). It is measured from a reference video, so nobody chooses it. It is an input to a request, and it fails closed when a measurement is missing.
- **Hook timing** (the window a hook must land in, and the re-hook interval). It does not exist yet as a preset. Task T12 adds it as configuration, with defaults from the research note (T2).

### The repurpose options, by category

The catalogue is already a Meridian-owned registry. It lists each option with its category, its label, its availability and the part of the visual treatment it sets.

| Category | Option | Sets (per `catalog.ts`) |
| --- | --- | --- |
| Warp and rotation | `zoom_in` (line 37), `tilt` (line 44), `drift` (line 51) | `framing`: zoom, rotation, offsets |
| Colour and look | `warm`, `cool`, `faded`, `mono` (lines 57 to 60) | `look.preset` and `look.strength` |
| Frame and mirror | `mirror` (line 62), `tight_frame` (line 69) | `mirror`; `framing` zoom |
| Texture and grain | `grain_fine` (line 75), `grain_heavy` (line 77) | `grain.strength` |
| Lighting | `vignette_soft` (line 83), `vignette_deep` (line 85) | `vignette.strength` |
| Text style and overlays | `text_style` (line 92) | Unavailable: no text overlay treatment exists, so it is not offered (reason at line 95) |

Two capabilities are listed as unavailable with a reason (`UNAVAILABLE_CAPABILITIES`, line 109): `templates` and `packs`. Each option sets its part as a fraction of its full strength, so one intensity scales every option the same way.

## 2. The duplication this proposal removes

- The look data lives in two places: the enum in `edl.ts:17` and the overlay table in `compiler.ts:48`. Adding a look means editing both, and a missing overlay is a compile error rather than a missing feature. That is good, but the table could sit beside the registry instead of inside the compiler.
- The repurpose catalogue and the look table both name the same four looks. Nothing checks that they stay in step.
- Caption styles and the style kit are separate lists with no shared shape.

## 3. The proposed model

One registry module, `src/engine/repurpose/presets.ts` (name to be confirmed), holds every preset as data:

```
preset = { family, id, label, version, data, availability }
```

- **family** is one of the five above.
- **id** is stable and never reused. A retired preset keeps its id and is marked unavailable, so an old EDL still resolves.
- **data** is validated at the boundary by the family's own schema. An unknown id is refused with a typed error (`invalid_input`), never defaulted (fail closed, CLAUDE.md rule 1).
- **availability** says whether the engine can draw it, and gives the reason when it cannot. This is the existing `OptionAvailability` shape.

The compiler reads the look overlay from the registry. The catalogue reads its options from the registry. Nothing else defines a look.

## 4. What needs a contract change

Each item below is a change to a zod schema or a version, so each needs the owner's or the lead's approval, a version bump in `contracts/version.ts`, and a migration note in Bible section 4.

| Change | Why | Contract |
| --- | --- | --- |
| A fifth look | `LOOK_PRESETS` is a zod enum in `edl.ts:17`, and `visualTreatmentSchema` uses it | Yes: `engine-contracts@12` |
| A new caption style | `CAPTION_COMPONENTS` is an enum in `kits.ts` | Yes |
| A new palette role or font role | `styleKitSchema` names each role | Yes |
| A new visual field, such as a caption-timing preset | `visualTreatmentSchema` has `version: z.literal(1)` | Yes |
| A new repurpose option that sets an existing field | Only the catalogue changes | No |
| A new grain or vignette level, or a new framing amount | The fraction scales an existing value | No |
| Editor tuning values (caption bands, build steps) | They live in `thresholds@3`. A value the Bible gives is a constant; a value it does not give is a Tunable whose bounds the lead confirms (`thresholds.ts`, header) | No contract change. A Tunable's bounds need the lead's confirmation |

Nothing in the first three rows is needed for this run. The registry in T11 works on the existing contracts, so it needs no approval. If the owner wants a new look or a caption-timing preset (Q1), the change goes through the approval path above.

## 5. Recommendation

1. Approve the registry (T11) now. It needs no contract change, and it removes the duplication in section 2.
2. Decide Q1 separately, after T11 is in. The registry will show exactly which presets are missing, instead of arguing about them in the abstract.
3. Keep the hook timing rules (T12) out of the contracts. They are configuration, and they stay tunable without a version bump.

## 6. Not checked here

- Whether a change to a `thresholds@3` value needs a version bump. The file's header says a value the Bible gives is a constant and a value it does not give is a Tunable whose bounds the lead confirms. It does not say whether a value change alone bumps the version, and this proposal did not read the rest of the file.
- The caption component library's drawing code (`src/engine/compose/library.ts`), which decides how each caption style looks. It was not read.
- Whether any of the preset families is read by the Content Factory UI. The UI reads the catalogue through the engine's read API, which was not traced.
