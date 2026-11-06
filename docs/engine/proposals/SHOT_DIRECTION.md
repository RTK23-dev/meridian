# Proposal: the ShotDirection contract (for the owner or lead)

**Status:** proposed, not applied. The schema exists as `src/engine/direction/film.ts` (`meridian.directed_film/v1`). Today it is used
by:

- the direction check;
- the prompt compiler;
- the code-drawn pixel crew;
- agent mode.

It does not pass between engine stages, because a contract change needs the owner's or lead's approval, a version bump in
`src/engine/contracts/version.ts` and a migration note in Bible section 4 (CLAUDE.md rule 4).

## Why

The engine directs the script but only describes the shots (MERIDIAN_DIRECTION_LESSONS.md, section 1). `planner@1` writes a picture
prompt from subject, setting, light, camera and mood. Its only style input is a palette and a motion intensity. Nothing says:

- what happens;
- when it hits;
- how it winds up and settles;
- where the eye goes;
- what stays empty for the words;
- whether it loops;
- what must never appear.

The study of 14 pixel-art science reels (docs/engine/STYLE_PRESET_PIXEL_EXPLAINER.md) measured what directed shorts do:

- the answer lands by 3 s in 12 of 12;
- one literal picture per line;
- every short is a frame loop (12 of 12, loop distance at most 0.022);
- the words sit in a band the subject never crosses.

## What changes when it is approved

1. **Contracts.** Move `lookSchema`, `shotDirectionSchema`, `cardSchema`, `hudSchema`, `claimSchema` and `directedFilmSchema` into
   `src/engine/contracts/`. Then:
   - add `directionId` (the film's content hash) and `shotId` references to `shotSpecSchema`;
   - add `shot_director` and `pixel_crew` to `ClaudeRole`;
   - bump the contract set version and write the section 4 note.
2. **Plan.** The Director role (`prompts/shot_director@1.md`) writes the film once after the script. The film is frozen and stored by
   content hash. Every shot spec names its direction.
3. **Check before spend.** `direction/check.ts` runs as the director check; a blocking finding stops the plan before any paid call
   (L2).
4. **Produce.** `produce_shot` compiles its provider prompt and negative prompt from the shot's direction (`direction/compile.ts`). A
   freehand prompt is refused. A code-drawn style uses the pixel crew instead.
5. **Review.** `direction/take-check.ts` joins take review:
   - a moment with no visible change, an open loop, palette drift or an avoided item is a reject reason, with a retry or a reroute;
   - the reason is logged for the learning loop (L9).
6. **Compose.** The sound cues of `sfxCues` become an SFX track on the EDL (L11).

**Done when:**

- no `produce_shot` job runs without a valid direction;
- a shot missing its moment or its avoid list fails validation;
- a run log shows a Director artifact frozen before any generation call, which the crew steps reference by id (L1, L2).
