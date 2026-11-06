# Motion in Meridian

This skill is [motion-kit](https://github.com/hughminhphan/motion-kit) by Hugh Phan (MIT, `LICENSE`), vendored at commit `6173e5c`.
`SKILL.md`, `LIBRARY.md` and `motion-kit.js` are as published. In Meridian:

- **Engine compositions** (`src/engine/compose/`): the compiler ships the kit as `lib/motion-kit.js` and loads it after GSAP. A
  component loads `../lib/motion-kit.js` after GSAP and authors with `window.MotionKit`. Read `src/engine/compose/motion/README.md`
  before changing a component's motion.
- **The check**: `src/engine/compose/motion/lint.ts` blocks named GSAP presets, `gsap.defaults` and blur-ins, and warns on even
  staggers and fades from nothing. `motion/lint.test.ts` runs it on every component and on the compiled root.
- **Later elements**: hide with an immediate `gsap.set(el, { autoAlpha: 0 })` outside the timeline and cut on at the cue
  (`MotionKit.cut`). HyperFrames does not render a set at exactly 0 on frame 0, so an element on screen from the start is shown with
  an immediate `gsap.set(el, { autoAlpha: 1 })` instead.
- **CSS-hidden elements**: many components hide an element in CSS (`opacity: 0`) and used to reveal it with the fade they no longer
  have. Removing a fade means adding its reveal, or the element never appears. The golden frames catch this; the static checks do not.
- **Plan timings win**: when a plan gives a duration (an entrance in ms, a word step, a drop time), keep it and shape the move inside it.
- **Code without GSAP** (canvas scenes, agent-mode renders): use the same curves from `src/engine/compose/motion/kit.ts` (`curve`,
  `bez`, `dur`, `react`), or load `motion-kit.js` in the page and call `MotionKit.curve(name)` on normalised time.
- **Registers**: `src/engine/compose/motion/registers.ts` maps the direction codex's feeling to a register (awe to premium, amusement
  to playful, tension to expressive, relief to calm; editorial otherwise).
