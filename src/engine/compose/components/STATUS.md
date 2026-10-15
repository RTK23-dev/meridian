# STATUS: component library (Bible 9.2), E1, E2 and E5 sets

Full status is in `../STATUS.md`. E5 is on branch `eng-e5-visual-types`.

## E5 components (`kinetic.type`, `screen.mock`, `character.rig`)

- **`kinetic.type`** (`props.ts`: `lines` of `{text, atMs}`, `emphasis`, `entrance` stagger or pop, `wordStepMs`, `band`).
  Fixtures: `stagger-three-lines` (frames 1200, 2200), `pop-emphasis-upper` (400, 1500), `lower-band-long-line` (1200).
  Used by `kinetic_type` shots that speak emphasis words (plan/sources.ts). Without emphasis, `kinetic.punchline` stays.
- **`screen.mock`** (`props.ts`: discriminated union on `screen`). Fixtures: `notification-phone` (1100), `app-rows-phone`
  (900, 1500), `chat-desktop-markup` (1600, 2600). The markup message shows as text.
- **`character.rig`** (`props.ts`: `rigId` (`bean.v1` only), `characterId`, `position`, `poses`, `mouth`). The template
  is a static SVG with named parts, driven by GSAP `fromTo` and `set` calls that use `immediateRender: false`. Fixtures:
  `idle-talk` (700, 1250), `point-and-cheer` (1000, 2100), `think-surprise` (600, 1500).
- Golden PNGs: 16 frames, written by the golden harness for the three new components only (the same code path as
  `golden.update.ts`, run for these names), so the existing PNGs did not change. The frames were viewed by eye: `character.rig` idle-talk@700,
  point-and-cheer@2100, think-surprise@600 and @1500; `screen.mock` notification-phone@1100, app-rows-phone@1500,
  chat-desktop-markup@2600; `kinetic.type` stagger-three-lines@2200, pop-emphasis-upper@400 and @1500. The other frames were
  written from the same render but not viewed one by one; the lead should view them before merge.
- Fixed while viewing: the think arm (-40 hung down; now -120 raises it to head height); the surprised brow lift (-14 touched
  the head outline; now -8); the emphasis punch of kinetic.type (0.3 overlapped the neighbour word; now 0.18, with 0.05em
  padding per word). The `kinetic.type` box is centred on 47% of the width, as title.hook is (6% to 88%, the right 12% kept clear).
- The rig is one built-in SVG. Its names are the contract with the character sheet: poses and mouth shapes must be names the
  rig draws. `characterSheetFixture` in contracts/fixtures lists visemes `A, E, O, M, rest`, which the rig does not draw, so
  that sheet cannot drive it (plan/sources.ts refuses it, with the reason).

## E2 set (the E2 notes below still hold)

Phase E2, branch `eng-e2-components`, cut from `code/beautiful-cori-1zfk11` (a4b04c7).

- Done in E1: `captions.karaoke`, `title.hook`, `kinetic.punchline`, `product.card`, `cta.card`.
- Done in E2: `react.layout`, `list.tierBoard`, `compare.split`, `price.reveal`, `chat.thread`. Each has `component.html`,
  `props.ts` (zod), `fixtures/` (3 prop sets), `index.ts`, and golden PNGs in `golden/`.
- Tests: `components.test.ts` (contract for all ten: props, declared variables, no wall clock, markup or network APIs, kit
  colours only, no innerHTML), `e2.test.ts` (prop rules, price formatting, escaping through the compiler, nested media,
  a ten-component composition that compiles to the same hash twice, safe-zone geometry). `../lint.test.ts` runs
  `hyperframes lint` on every fixture. Golden frames run with `npm run engine:golden`.
- Text, prices and logos are drawn by code only (L8). `price.reveal` takes integer minor units and a currency code, and
  its schema formats the text (`formatPrice`); `chat.thread` draws each message with `textContent`.
- Media in components: `react.layout` and `compare.split` take image or video URIs; `list.tierBoard` item images take
  image URIs only (refused at the schema). Video in a component is covered by a golden frame (placeholder video).

## Decisions (E2, for the lead to confirm)

- `list.tierBoard`: at most five tiers, at most four items per tier, labels of two characters, names of 24 characters.
  The grid is four columns, so a tier row fits the 82% column. Tones map to kit colours only.
- `compare.split`: labels of 12 characters at most, so each sits inside its half and the right 12% stays clear. The
  right panel wipes in at `revealMs` and slides with `--kit-motion`.
- `price.reveal`: currencies USD, EUR, GBP, JPY, CAD, AUD. Symbols: `$ € £ ¥ CA$ A$`. Amounts are positive integers in
  minor units, at most 1,000,000,000. Format: thousands grouped with commas; a zero fraction is dropped (`$49`, `$49.99`).
  The new price's font size is set by its character count (at most 260 px), so the number fits the 82% column.
- `chat.thread`: up to ten messages of 200 characters. Each has a side, a time and an optional typing lead-in of at most
  3 s, which starts after the message before it. The list is bottom-anchored, so older messages clip off the top.
- `react.layout`: picture-in-picture at one of four corners inside the safe zones, 24% to 40% of the frame width.
  Media in-points (`baseInMs`, `presenterInMs`) are props, because the compiler passes no `srcInMs` to a component.
- Compiler (`compiler.ts`): the `*Uri` mapping now walks objects and arrays, and maps `*Uris` lists too. Before, only
  top-level `*Uri` props were mapped, so a list item's image would have leaked its EDL URI into the HTML. Compositions
  without nested URIs compile to the same bytes as before (the E1 snapshot is unchanged).
- Golden media (`test/golden/harness.ts`): placeholder images are coloured gradients chosen by file name, and video
  placeholders are generated with ffmpeg (VP8, 216 × 384, solid colour, 6 s). Lint mode writes empty files, so
  `npm test` needs no ffmpeg. The product hero frame is unchanged.
- Two fixes made after first renders: the tier board's title sat at the top edge (now 10% down, board 70% tall, inside
  the safe zones), and the secondary tone's label was near-white on a light tile (now kit text colour).

## Verified here

- `hyperframes lint`: 31 of 31 (the contracts EDL and 30 component fixtures) with zero errors and zero warnings.
- Golden frames: see `../STATUS.md` for the counts from the final run.
- Visual checks by eye: `react.layout` picture-in-picture placement and timing (hidden before `pipInMs`, shown after),
  `compare.split` labels and wipe, `list.tierBoard` drops and labels, `price.reveal` (struck old price, new price after
  the reveal), `chat.thread` typing and bubbles, markup shown as text.

## Owner's live run (E2 part of acceptance, Bible 19)

Agents hold no keys. Before E2 is called done, the owner runs one composition with a clip of each new component through
the HeyGen cloud render (the E1 live run in `../STATUS.md` covers the adapter). Check on the cloud output:

1. `react.layout` with a real video presenter: the `<video>` inside the sub-composition plays and is in sync (local
   placeholder video is verified; the cloud renderer must match it).
2. `compare.split` with a real video on the right: the wipe and the video both appear.
3. `list.tierBoard` with real product images (L8): they are product imagery, not generated.
4. Font check as E1: the kit's fonts are bundled. A kit that names a font outside the bundled set is fetched at render
   time and is a determinism risk.

## Blockers

- None in code. Product beats need real imagery (L8). `list.tierBoard` and `react.layout` take it as URIs; the
  pre-render gate (eng-review, W11) must refuse a product beat with no image.
