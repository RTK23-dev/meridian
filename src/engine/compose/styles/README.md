# Code-drawn styles

Four looks Meridian draws entirely in code, each with a built-in cookbook (`src/lib/meridian/cookbooks/builtin/coded-styles.ts`). A fifth
cookbook wraps the 8-bit explainer, which the pixel crew already draws (`../pixel/`). They are the best five of the 51 styles on Applied AI's
"Claude animation styles" page, chosen for Meridian (owner request 2026-11-09):

| Cookbook | Style | Good for |
| --- | --- | --- |
| `ck_isometric_explainer` | A route of labelled stages on an isometric ground, with a packet travelling it | Tech and process explainers |
| `ck_paper_cut_story` | Cut-paper layers lit back to front, a slow parallax push-in, the light finding the hero | Story intros, brand moods, hooks |
| `ck_line_diagram` | A diagram that draws itself in thin lines on navy, with one warm accent | Science and how-it-works |
| `ck_stacked_data_chart` | A bar chart built from stacks of coins, cash or blocks, one token per unit | Data and finance reveals |
| `ck_pixel_explainer` | The pixel crew's directed 8-bit science short | Science shorts |

## How the five were chosen

The rest of the list was left out for reasons that would make it a bad fit for Meridian:
- **New dependency:** the physics styles (dominoes, Galton board) need a physics library.
- **Needs Blender:** the Blender styles need Blender.
- **Copies someone:** the styles named after a creator, or a toy brand, copy someone else's look.
- **Backgrounds only:** the remaining looks (synthwave, glass mosaic, product spin) make backgrounds or effects rather than a video that tells something.

Each look was designed from a written description, not copied from footage. Every shape, colour, move and sound is Meridian's own,
drawn or synthesised here (CLAUDE.md rule 6). The look is not measured against a reference video, so these are not style presets
(`../../presets/` holds only measured ones). Each has a style kit in `kits.ts` instead.

## The pieces

- **The spec** (`specs.ts`): `specs.ts` holds what a person, a chat or the planner fills in for one video: the words and numbers only.
  - **Limits:** every text field is bounded so it fits its place on a 1080 x 1920 frame.
  - **Chart honesty:** a chart of real figures must name its source, or say on screen that it is illustrative. Every stack is counted from `perToken`, never scaled, so the key is true.
  - **Examples:** `examples/` holds one spec per style.
- **The drawing:** one plain JavaScript module per style draws a frame as a pure function of time. It uses no wall clock and no unseeded randomness, so any frame renders the same every time.
  - **Modules:** `isometric.js`, `paper-cut.js`, `line-diagram.js` and `stacked-chart.js`, with shared helpers in `common.js`.
  - **Motion:** moves use the motion kit's curves.
  - **Loop:** the last second returns to the opening frame, so the video loops.
- **The renderer** (`scripts/engine/applied-styles/render.ts`): draws every frame in the local Chromium, synthesises the style's sound, masters to −14 LUFS and encodes MP4. It then measures the take: its length, its loudness and how far the last frame is from the first. There is no provider call, and the result is labelled "made in agent mode".
  - Bed and cues: the style's own bed, plus a tick, pop, whoosh, thud or chime on the style's cues.
  - Stills: `node --experimental-strip-types scripts/engine/applied-styles/render.ts --spec <spec.json> --stills 0,4,9 --out <dir>`
  - Video: `node --experimental-strip-types scripts/engine/applied-styles/render.ts --spec <spec.json> --out <dir>`

## Not built yet

- **Cloud video engine:** these looks are drawn in agent mode, or by a chat writing a HyperFrames composition from the cookbook's instructions. The cloud video engine's compiler cannot draw them, so the cookbooks offer agent mode only.
- **AI voice:** a chat on the connector can add an AI voice (`meridian_voiceover`) and mix it in itself. In the app, the cookbook offers no voice-over or the person's own recording.
