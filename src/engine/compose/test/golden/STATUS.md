# STATUS: golden-frame harness (Bible 17.3)

Phase E1, wave B. Branch `engine/e1-w9-w10`. Full status is in `../STATUS.md`.

- Done: `harness.ts` (one-clip compositions, local CLI render, ffmpeg frame extraction, PNG pixel diff under 1%) and
  `golden.run.ts` (`npm run engine:golden`). Not part of `npm test`: it needs a Chrome headless shell and ffmpeg.
- Run: `HYPERFRAMES_BROWSER_PATH=<headless shell> npm run engine:golden`. Result here: 15 pass, 0 fail.
- Rewrite PNGs only after a review by eye: `npm run engine:golden:update` (entry `golden.update.ts`). The compare
  and update runs share `suite.ts`, and neither reads an environment variable of its own.
- Local rendering is for tests only (Bible principle 8). Production renders go through `render/`.
