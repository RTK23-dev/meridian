# Accessibility

Target: WCAG 2.2 AA. This document does not claim conformance. The repo is not certified, and nothing here is an audit result until the testing pass in `docs/UI_OVERHAUL.md` (Phase 9 and Phase 10) has run and its output is recorded.

## Implemented in code

Language and structure
- `<html lang="en">` in the root layout. A skip link to `#main` is the first focusable element.
- Landmarks. The signed-in shell has one `header` (banner), one `main#main`, a desktop `aside` with the primary `nav` (shown from `lg`), a mobile sheet with the same `nav` (opened from the header or the bottom bar), a `nav` named "Quick navigation" (below `lg`), and a `nav` named "Location" in the header (from `md`). Each screen that shows breadcrumbs has a `nav` named "Breadcrumb". The signed-out welcome, sign-in page, not-found page and the loading state of `/login` each render one `main`. The review inbox list is a named `section`, not a `nav`.
- Every signed-in route declares a `pageTitle` (`src/routes/_app/**`). The shell sets `document.title` from it. `/login` sets "Sign in · Meridian" and the signed-out welcome sets "Welcome · Meridian". The `/_design` page is development-only and returns not-found in production.
- Route changes. The shell moves focus to the page `h1` (or to `main` when a screen has none yet) on each path change.

Focus and keyboard
- One focus style for every theme: `:focus-visible` gives a 2px solid accent outline with a 2px offset (`src/styles.css`). Controls no longer set `outline-none` or use a box-shadow ring. A pairing of `outline-none` with `focus-visible:outline-2` had hidden the focus of the glossary term trigger, and that is fixed.
- Accent focus colour: 4.82:1 on the light background and at least 8:1 in dark mode, above the 3:1 non-text target.
- Dialogs, alert dialogs, sheets and popovers use Radix or vaul (Radix Dialog underneath). Both trap focus while open, return focus to the trigger on close, and close on `Escape`. The command palette uses cmdk's `Command.Dialog`, which is built on Radix Dialog. Its backdrop is now the Radix overlay, so the separate focusable backdrop button was removed.
- Menu rows (`DropdownMenuItem`) and select rows keep the global focus outline on keyboard focus.

Announcements
- One sonner `Toaster`, mounted once in `src/routes/_app.tsx`. Sonner renders its region as a `section` with `aria-live="polite"`, even when there are no toasts.
- Field errors use `role="alert"`. Loading states (`ScreenSkeleton`, `ChartSkeleton`, the data-table loading state) use `role="status"` with a label.

Text alternatives for state and charts
- Status badges (`StatusBadge`, `StatusText`) write the status in text with an icon. All 43 `Badge` call sites render text.
- Every recharts chart has a text alternative: the learning value charts sit in a labelled section with a visible table of every value (`ChartFigure` and `ValueTable`); the brand overview charts list their counts; the studio learning bars sit above a text list; the intelligence trait bars carry a visually hidden table; the opportunity rank radar has a summary sentence (`scoreSummary`); the KPI sparkline has a summary sentence (`sparklineSummary`), although no screen passes it data yet.
- Completeness rings and the research run progress bar expose their percentage in `aria-label` or `aria-valuetext`.

Motion and contrast
- `prefers-reduced-motion: reduce` cuts every CSS transition and animation to 0.01ms, which covers the new components. Recharts bar animation reads the same media query and is turned off when the reader asks for less motion.
- `prefers-contrast: more` raises the border, strong border, muted text, foreground and accent tokens (`src/styles.css`, one block for light and one for dark). The default-theme text pairs are checked by `src/styles.contrast.test.ts` and `src/components/ui/tokens.test.ts`. The high-contrast values are not in those tests yet. They were checked with the same contrast formula only.

Target size
- On touch screens (`pointer: coarse`), buttons, tabs, menu rows, select rows, command palette rows, the header icon buttons, the user menu trigger, the table sort and column controls, and the term and calendar buttons are at least 44 by 44 px.
- Small controls keep their drawn size and get a 44 by 44 px hit area on touch (`.touch-hit-44`): the switch, the checkbox, the radio and the slider thumb.
- On desktop, checkboxes, radios, switches and slider thumbs are 24 px or more. Buttons are 32 px (`sm`) or more.
- The reviews split view has a 24 px resize handle (44 px on touch), with the visible line unchanged.

Responsive layout
- Data tables collapse to cards below 768 px (`md`): `DataTable`, the opportunity table, the research table view, the studio compare table, the evidence sheet, and the publishing queue. The cards read the same rows and keep the same role checks.
- Narrow screens use sheets for detail (opportunity, research, job, evidence, trace, product, publish and review dialogs). The reviews split view stacks the list and the detail below 1024 px and has no side panel on narrow screens.

Images and media
- Avatars, logos and the user-menu avatar have explicit `width`/`height` and `decoding="async"`, with `loading="lazy"` where the image is off screen. The brand logo uploader sets `height` to match its `h-16` class, and its width follows the aspect ratio.
- The lightbox image takes the stored width and height from the variant, so its box is reserved before the image loads.
- Creative thumbnails and the media player's images already set `loading="lazy"`, `decoding="async"` and explicit dimensions.

Performance (code splitting)
- recharts is loaded with `React.lazy` in the opportunity sheet (rank radar), the brand overview (two review charts, only when open items exist), the learning screen (value bar and line plots, in `src/components/learning/chart-plots.tsx`), the intelligence screen (trait bars, `src/components/market/intelligence-patterns.tsx`), and the studio learning panel (learning bars). Each lazy boundary has a skeleton fallback that keeps the plot's height.
- The media player is loaded with `React.lazy` through `src/components/lazy-media-player.tsx`, used by the library trace drawer, the studio compare view and the studio variant cards. Its fallback is a media-shaped skeleton.
- The pure trait-row helper moved to `src/components/market/trait-rows.ts`, so the intelligence route does not load recharts for its data step.

## Verified by automation

- Token contrast for the default theme: `src/styles.contrast.test.ts` and `src/components/ui/tokens.test.ts`. These run with `npm test`.
- `node scripts/a11y-audit.mjs` creates an account through the real sign-up form and runs axe on `/`, `/settings`, `/integrations` and `/brands/new`. It tabs through eight brand screens and checks for a keyboard trap, checks a 320px and a 640px viewport for horizontal overflow, and checks reduced motion. It does not cover the 360, 390, 768, 1024 and 1440 px set in the plan, or dark mode. Run it while the app is up. A failure is a failure. A pass is not a conformance claim.

## Not verified yet (the testing pass must check)

These were not run in the code phase of Phase 9, which did not run the test, lint, build, end-to-end or axe commands.

- axe (`@axe-core/playwright`) on every route in light and dark, at 360, 390, 768, 1024 and 1440 px. The phase 1 result (no axe violations on the captured routes) must still hold. The axe result must be recorded from a real run.
- Keyboard tour of each screen: every control reachable, every dialog, sheet and palette trapping focus and returning it to the trigger, and route changes moving focus to the heading.
- Focus ring colour and offset in light and dark, and under `prefers-contrast: more`.
- Touch target sizes on a touch device (44 px) and desktop sizes (24 px minimum). The sizes above come from class names, not from measurements.
- No horizontal page scroll at 360, 390, 768, 1024 and 1440 px. The data tables use an inner `overflow-x-auto` container from 768 px up, so a wide table can still scroll inside its own box between 768 and 1023 px. The testing pass must measure this.
- Fixed widths found in the phase 4 and phase 8 screens, which the testing pass should check at 360 px: `min-w-[46rem]` and `min-w-[44rem]` (inside the md-and-up tables), `min-w-[32rem]` (compare table, md and up), `min-w-64` (value tables and form fields, about 256 px, which fits 328 px of content at 360 px), and the `min-w-32` usage bar. The studio lightbox zoom uses an inner `overflow-auto` box, which is intentional.
- Screen readers (VoiceOver, NVDA or JAWS) on the review, opportunity, integration and calibration screens, and on the charts and the new card layouts.
- Reduced motion and high-contrast rendering, and the recharts output with animation turned off.
- Bundle budget: the main JavaScript for the shell is targeted at under 250 kB gzip (`docs/UI_OVERHAUL.md`, Phase 9). It has not been measured. No CI job was added in this phase, so the budget is not enforced.
- Largest contentful paint on the studio page with 20 variants, and layout shift from fonts. Neither was measured.
- Lists over 100 rows. The UI code read in this phase caps the audit list (50 per page), the calibration and job lists (server pages), the webhook list (50 per page), the alerts list (40), the review list (40), and the performance rows (10,000 stored, top creatives only shown). It does not cap the research ads, library creatives or the opportunity list in the UI code, so a brand with more than 100 rows would render them all. No virtualization library was added. Test with a large brand before deciding.

## Known gaps

- Generated video has no caption or transcript track. The player labels the video "Generated video" and shows the stored duration. Captions are not claimed.
- Studio variant cards show their selection with a ring, and they take focus to select. The focus indicator is the selection ring, not the global outline.
- The lightbox zoom area scrolls inside its own box when zoomed. Keyboard users can reach it, but the testing pass must confirm the scroll position is reachable with the keyboard.
- The signed-out welcome and the `/login` route do not move focus to their heading on navigation. Only the signed-in shell does.
- Server code still returns base64 data URLs for studio previews in `src/lib/meridian/studio/session.server.ts`. The UI does not add to that. Moving previews to the asset route is a server change and is outside this phase.

## Charts and video

Recharts is used on the opportunity, brand overview, learning, intelligence and studio screens (see above). Each chart has a text alternative. The learning value charts show a visible table, and the other charts have a summary or a list. No chart is the only source of a number.

## Not claimed

This is not a WCAG 2.2 AA certification. The axe script does not weaken production authentication: there is no fixture login that skips the account form.
