# engine/compose/pixel

The code-drawn crew of the 8-bit explainer style (`presets/pixel-explainer.ts`). It draws a directed film's pixel build with no
provider call.

| File | What it is |
| --- | --- |
| `stage.ts` | `meridian.pixel_build/v1`: one stage per shot, with a backdrop, a camera, actors (shapes with faces, fields of copies with an uneven stagger), their actions on the motion kit's curves, and effects. Coordinates are logical pixels of a 180 x 320 frame |
| `pixel-engine.js` | The renderer. Plain browser JavaScript, excluded from tsc and ESLint like the motion kit. Every frame is a pure function of time, so any frame can be drawn in any order |

**The look the engine holds:**

- a logical frame scaled by a whole number, so a pixel is one size at every zoom;
- three-tone ordered-dither shading and a dark outline;
- faces whose eyes stay level on a turning body;
- a bold 5x7 pixel font in upper case, with the payoff words in the keyword colour, cut on rather than faded;
- soft glows and fine grain.

**How it moves:**

- characters move on the shot's cadence (twos by default) and the camera moves on ones;
- moves wind up, whip and settle;
- a flip is a mirror;
- a dive zooms on a log scale.

The engine runs today through `scripts/engine/pixel-explainer/render.ts` (agent mode). A `pixel.scene` component for the engine's own
render path is the next step (preset gaps).
