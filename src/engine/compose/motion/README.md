# engine/compose/motion

Designer motion for every composition. Agent-made video has a look, and it comes from defaults: every element fades up on one named
curve (`power3.out`), over the same 0.3 to 0.6 s, an even 0.08 s apart, then nothing moves. This module replaces that with the way an
After Effects animator keys a move: a curve chosen per move and per property, a duration from distance and weight, one element leading
and the rest reacting at uneven offsets, springs for physical landings, and text that mostly cuts on.

The method and the code are [motion-kit](https://github.com/hughminhphan/motion-kit) by Hugh Phan, MIT (see `LICENSE`), vendored at
commit `6173e5c` (2026-11-04). The agent skill is `.claude/skills/motion-designer` (the same files, with Meridian's notes).

| File | What it is |
| --- | --- |
| `motion-kit.js` | The kit, byte for byte as published. `kit.test.ts` checks its hash. Plain browser JavaScript, so it is excluded from the TypeScript and ESLint runs. |
| `kit.ts` | `MOTION_KIT_PATH` (`lib/motion-kit.js` in a composition) and `MOTION_KIT_SOURCE`; every curve as data (`KIT_CURVES`), with `bez`, `curve`, `dur` and `react` for code that does not run GSAP (canvas renderers, agent-mode scenes). `kit.test.ts` checks the numbers match the kit exactly. |
| `registers.ts` | The six registers (technical, editorial, premium, expressive, playful, calm) with their curves, spring damping and pace, and the register a feeling suggests (the direction codex's emotion ids). |
| `lint.ts` | The motion "unslop" check: named presets, `gsap.defaults` and blur-ins block; even staggers and fades from nothing warn. |

## How a composition uses it

- The compiler writes `lib/motion-kit.js` into every composition and loads it in the root after GSAP. The root timeline draws with it:
  a whip snaps on `kit.whip`, a punch-in lands on `kit.land` and settles back on `kit.heavy`, a shake is a decaying, uneven jolt, one
  step per frame. A crossfade and a flash stay linear.
- Every animated component loads `../lib/motion-kit.js` after GSAP and authors with `window.MotionKit` (HyperFrames resolves a
  sub-composition's script from its own folder, and accepts `../` that stays inside the project).
- An element that appears later is hidden with an immediate `gsap.set` outside the timeline and cut on at its cue (`MotionKit.cut`).
  HyperFrames does not render a set at exactly 0 on frame 0, so an element on screen from the start (most are hidden by the
  component's CSS) is shown with an immediate `gsap.set(el, { autoAlpha: 1 })`. Each component's `reveal(el, at)` does both.
- Durations a plan gives (an entrance in ms, a word step, a drop time) are kept: the kit shapes the move inside them, and `dur()` only
  sets times the plan does not.

## What the components do now

| Component | Before | Now |
| --- | --- | --- |
| `title.hook` | pop on `back.out(1.7)` with a fade; slide on `power3.out` with a fade | pop: on screen at once, scale on a spring (damping 0.78); slide: `kit.land` over the distance's time; fade only when the plan asks |
| `kinetic.type` | words fade up at an even word step | the first word leads, the rest answer at uneven offsets paced by the word step, cut on with a short `kit.land` rise; emphasis on a spring with a visible settle |
| `kinetic.punchline` | `power3.out` | each line slams onto a spring inside its beat |
| `cta.card`, `cta.follow`, `label.pill`, `react.layout`, `stat.counter` | scale and fade on `back.out` | cut on, scale on a spring that is felt, not seen; the CTA keyword answers the card a beat later; the arrow breathes on `kit.drift` |
| `list.tierBoard`, `screen.mock` notification | drop with a fade | cut on at the drop, landing on a spring with a visible settle |
| `panel.bars`, `panel.tiles`, `panel.line` | the panel fades in; bars and tiles at an even step | the panel settles with weight (`kit.heavy`); bars grow over a time set by their height, tiles cut on, both at uneven offsets; each value cuts on as its bar lands; each line point cuts on the moment the line reaches it |
| `product.card` | card fades up; bullets at an even 0.18 s | the card arrives with weight, the price answers on a spring, the bullets lead and answer |
| `chat.thread`, `screen.mock` rows and bubbles | fade and slide on `power2.out` | cut on, settling a short rise or slide timed by its distance |
| `compare.split` | wipe on `power3.out` | wipe on `kit.reveal` |
| `character.rig` | every part on `power2.out` at once | arms lead on `kit.land`, the head follows two frames behind on `kit.heavy`, brows snap on `kit.whip`, lids on `kit.drift` |

## Checks

- `motion/lint.test.ts`: no component chooses a preset, an even stagger or a blur-in; `title.hook` keeps its one chosen fade; the
  compiled root passes.
- `lint.test.ts`: `hyperframes lint` on every component fixture and on the compiled EDL fixture, zero errors and zero warnings.
- Golden frames (`npm run engine:golden`): rewritten after a review by eye, because the frames inside a move changed.

## Not yet

- The register is not on the request: choosing one per video needs a style-kit field (a contract change for the owner, proposed with
  direction in contract v15). `registers.ts` maps a feeling to a register for when it does.
- The preset preview renderer (`scripts/engine/preset-preview/`) still eases everything with one smoothstep.
