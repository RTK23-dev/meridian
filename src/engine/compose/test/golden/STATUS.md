# STATUS: golden-frame harness (Bible 17.3)

Phase E1, wave B. Branch `engine/e1-w9-w10`. Full status is in `../STATUS.md`.

- Done: `harness.ts` (one-clip compositions, local CLI render, ffmpeg frame extraction, PNG pixel diff under 1%) and
  `golden.run.ts` (`npm run engine:golden`). Not part of `npm test`: it needs a Chrome headless shell and ffmpeg.
- Run: `HYPERFRAMES_BROWSER_PATH=<headless shell> npm run engine:golden`. Result here: 15 pass, 0 fail.
- 2026-11-05, motion kit (`../../motion/README.md`): every component's goldens rewritten after a review by eye, old beside new, and
  the seven components that had none (captions.boxed, cta.follow, label.pill, panel.bars, panel.line, panel.tiles, stat.counter)
  given theirs. The review caught three faults the static checks missed, all fixed before the rewrite: elements hidden by CSS that
  lost the fade that revealed them, a name shadowed by a hoisted `var`, and an undefined variable. Then `npm run engine:golden`:
  63 pass, 0 fail (headless shell 1194).
- Rewrite PNGs only after a review by eye: `npm run engine:golden:update` (entry `golden.update.ts`). The compare
  and update runs share `suite.ts`, and neither reads an environment variable of its own.
- Local rendering is for tests only (Bible principle 8). Production renders go through `render/`.
