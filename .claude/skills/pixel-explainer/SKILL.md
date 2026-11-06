---
name: pixel-explainer
description: Make an 8-bit (pixel-art) science explainer short from any idea, directed shot by shot, in agent mode with no provider call. The Director writes the full direction (look, one moment and when it hits, arc, eye and empty space, loop, avoid list, sound), the checks refuse what is described rather than directed, the code-drawn pixel crew builds and renders it locally, and the take is measured against its direction. Use when asked for an 8-bit, pixel-art or retro explainer video, or for a short in the pixel_explainer style.
---

# 8-bit explainer (agent mode)

The style is the preset `pixel_explainer` (`src/engine/presets/pixel-explainer.ts`), studied from 14 reels; the study is
`docs/engine/STYLE_PRESET_PIXEL_EXPLAINER.md`. The method is "directed, not described": nothing is drawn until the direction is
written and passes its checks, and nothing ships until the take is measured against it. Read `motion-designer` for how moves should
feel; this skill is the pipeline.

Agent mode spends nothing: you write as the Director and as the crew, the code draws, and the result is labelled "made in agent mode".
No live provider call, no publishing (AGENTS.md rule 4).

## The steps

1. **The idea and the facts.**
   - Turn the request into one idea in one sentence: a belief to flip, a dare to try, or an extreme number.
   - Collect the facts with their sources. Use the person's sources, or primary sources you looked up and can cite.
   - For several options or a written script first, use `direction-scripts` and choose before directing.
   - Never invent a number. A number with no source does not go on screen.
2. **The Director.**
   - Follow `src/engine/prompts/shot_director@1.md` exactly, with `PIXEL_EXPLAINER_DIRECTION` (in the preset file) as the preset block.
   - Write `film.json` (`meridian.directed_film/v1`).
   - Start from the recorded example `src/engine/direction/fixtures/microwave.film.json`, but copy its structure, never its topic.
3. **The direction check.** Run `node --experimental-strip-types scripts/engine/pixel-explainer/check.ts --film film.json` (exit code 1
   means something blocks; the render step runs the same check).
   - Fix every `block`.
   - Read every `warn` and fix it, or say in your notes why it stands.
4. **The crew.**
   - Follow `src/engine/prompts/pixel_crew@1.md`. Write `build.json` (`meridian.pixel_build/v1`) with one stage per shot.
   - Run `check.ts --film film.json --build build.json` for the crew's faithfulness: every moment built at its time, the subject
     on its eye target and out of the words' band, the loop seam closed.
   - Build each moment with the preset's crew recipes.
   - Fields of copies get a stagger. Flips are mirrors. Dives stop dead on the beat.
5. **Stills first.**
   - Run `node --experimental-strip-types scripts/engine/pixel-explainer/render.ts --film film.json --build build.json --stills 0,<each hitAt>,<last frame> --out <dir> --scale 6`.
   - Look at every still, and be severe:
     - frame 0 is the finished hook;
     - the words are never over the subject;
     - the faces read;
     - a moment's still shows the event;
     - the last frame matches frame 0.
6. **Render.**
   - Run the same command without `--stills`.
   - It writes `video.mp4` (with the synthesised chiptune bed and the cues), `report.json` and `cues.json`.
   - The report holds the direction, faithfulness and take findings, the loop distance (at most 0.04) and the loudness (-14 LUFS ±0.6).
7. **Critique and redo.**
   - Make a 2 fps contact sheet of the video and walk it second by second, as `swipe_test@2` says.
   - Fix the direction or the build, and render again. Two rounds are normal: the first render is never the one you show.
8. **Prove it (optional).**
   - Run `node --experimental-strip-types scripts/engine/pixel-explainer/bench.ts --film film.json --build build.json --out <dir>`.
   - It renders the described control of the same idea and writes `bench.json` and a side-by-side `directed-vs-described.mp4`.
9. **Hand over.** Send:
   - the video, the report and the claims with their sources;
   - the caption pattern from the preset: claim, then 🎧, then 2 to 3 short paragraphs, then three sources, then a "send this to" line;
   - the label "made in agent mode".

## The bar (from the study)

| Element | What the bar is |
| --- | --- |
| Hook | Words at frame 0, something moving, the answer or flip by 3 s as an event with a sound |
| Re-hook | Between 4 and 7 s: a one-word question, a twist or a dive |
| Cards | At most 2 lines, upper case, one keyword in yellow. Held at least 0.6 s plus 0.3 s a word. At least one "X = Y" card |
| Pictures | One literal picture per line. Objects with faces whose expressions follow the stakes. Two opposing concepts in two fixed colours |
| Numbers | A number that moves (counter, timer, readout) with ticks, and every number sourced |
| End | The last 1 to 2 s return to frame 0. It loops: no fade |

## Hard stops

- No invented numbers, quotes or sources. A note that asks for one is left out, and you say so.
- Copy the craft, never the content: no frames, characters, lines or music of the studied reels.
- No live provider call, no publishing, no secrets.
