# Accessibility

Target: WCAG 2.2 AA. This document does not claim conformance.

## Implemented in code

- Skip link to `#main` on every page.
- One `main` landmark on the signed-out welcome, the sign-in page, and the signed-in shell.
- Workspace and brand navigation expose `aria-current="page"`.
- Visible `:focus-visible` outline using the ink color on paper.
- Buttons and nav links use at least 44px height.
- Errors use `role="alert"`. Integration loading and connection results use `role="status"`.
- Status is written in text (`HEALTHY`, `REJECT`, `HUMAN_REVIEW`), not color alone.
- `prefers-reduced-motion: reduce` shortens animation and transition durations.
- Design tokens used for text meet a 4.5:1 contrast ratio. The check is `src/lib/meridian/a11y/contrast.ts` and `providers/readiness.test.ts`.

## Verified by automation

- Contrast ratios for ink, muted, brass, danger, paper, and panel.
- The production build renders the welcome page with text and no console errors. That is not a screen-reader audit.

## Requires manual verification

- VoiceOver, NVDA, or JAWS on the review, opportunity, and integration flows.
- Browser zoom at 200% and 400% on data-heavy pages.
- A real keyboard pass through create-brand, brief, review, and disconnect after sign-in.

## Still missing

- Automated axe scans of every authenticated screen. There is no axe suite yet, and the authenticated flows need a session the preview user does not share with CI.
- Charts are not a primary surface. Where a number is shown, the text is the value. There is no separate data-table alternative for a future chart.
- Video has no player. There is nothing to caption until a video provider is connected.
- Drag and drop is not used. Uploads use a file input.
