# engine/direction

Directed, not described. The Director writes the whole direction of a video before anything is generated or drawn. The checks refuse
what is described rather than directed. The crew builds exactly what was directed, and each take is measured against its direction.
The lessons are L1 to L13 (MERIDIAN_DIRECTION_LESSONS.md) and L14 to L23 (docs/engine/STYLE_PRESET_PIXEL_EXPLAINER.md, section 2.4).

| File | What it is |
| --- | --- |
| `film.ts` | `meridian.directed_film/v1`: the locked look, and for every shot the seven parts of direction. It also holds the cards, the moving numbers, the claims with their sources, the call to action and the loop. It is the proposed ShotDirection contract (`docs/engine/proposals/SHOT_DIRECTION.md`), not yet an engine contract |
| `check.ts` | The direction check: block and warn findings, each naming its lesson |
| `compile.ts` | A generated shot's provider prompt and negative prompt, compiled from its direction; the described control (L12); the sound cues (L4, L11) |
| `motion-vocab.ts` | The animation principles as words per provider family (untested until a live run) and as the code crew's numbers |
| `faithful.ts` | The crew's build against the direction: every moment built, the subject on target and out of the words' band, the loop seam closed |
| `take-check.ts` | A take's measures against its direction: moment visible, loop, drift, look, avoided items |
| `fixtures/` | The first directed film (microwaves) and its pixel build |

Nothing here calls a provider. Agent mode is `.claude/skills/pixel-explainer/SKILL.md`; the orchestrator plans the same order in
`prompts/orchestrator_plan@5.md` and notes a plan that skips it (`orchestrator/direction.ts`).

    NODE_ENV=development node --experimental-strip-types --test src/engine/direction/direction.test.ts
