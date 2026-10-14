# STATUS: component library v1 (Bible 9.2), E1 set

Phase E1, wave B. Branch `engine/e1-w9-w10`. Full status is in `../STATUS.md`.

- Done: `captions.karaoke`, `title.hook`, `kinetic.punchline`, `product.card`, `cta.card`. Each has `component.html`,
  `props.ts`, `fixtures/` (3 prop sets), `index.ts`, and golden PNGs in `golden/` (15 frames).
- Tests: `components.test.ts` (contract, safe zones, forbidden APIs, kit colours only). Lint of every fixture is in
  `../lint.test.ts`. Golden frames run with `npm run engine:golden`.
- Blocked on the owner: none for code. The text components' geometry is pinned by tests; a design change needs new
  golden PNGs (`npm run engine:golden:update`), reviewed by eye.
