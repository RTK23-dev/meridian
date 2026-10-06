# Accessibility

Target: WCAG 2.2 AA. This document does not claim conformance.

## Implemented in code

- Skip link to `#main`. The target can take focus.
- One `main` landmark on the signed-out welcome, the sign-in page, and the signed-in shell.
- Workspace and brand navigation expose `aria-current="page"`.
- Visible `:focus-visible` outline using the ink color on paper.
- Buttons and nav links use at least 44px height.
- Errors use `role="alert"`. Integration loading, alerts, and connection results use `role="status"`.
- `StatusText` writes the status in text, with a short word mark as well as the status name. Color is not the only signal.
- `prefers-reduced-motion: reduce` shortens animation and transition durations.
- Design tokens used for text meet a 4.5:1 contrast ratio. The check is `src/lib/meridian/a11y/contrast.ts` and `providers/readiness.test.ts`.
- Source uploads for text, DOCX, and PDF have a visible label.

## Verified by automation

- Contrast ratios for ink, muted, brass, danger, paper, and panel.
- `node scripts/a11y-audit.mjs` creates an account through the real sign-up form, then runs axe on the workspace, settings, integrations, and brand screens. It also tabs through those screens, checks a 320px and 640px viewport for horizontal overflow, and checks reduced motion. Run it while the app is up. A failure is a failure. A pass is not a conformance claim.

## Requires manual verification

- VoiceOver, NVDA, or JAWS on review, opportunities, integrations, and calibration.
- Browser zoom at 400% on the learning and review tables.
- A human keyboard pass of creative approve/reject after a real review exists. The automated walk tabs the page. It does not replace a screen reader.

## Charts and video

Recharts is installed and unused. No chart is rendered. Numbers on the learning and brand screens are text. There is no chart title to add until a chart exists. Video has no player, so there is nothing to caption until a video provider is connected.

## Not claimed

This is not a WCAG 2.2 AA certification. The axe script does not weaken production authentication: there is no fixture login that skips the account form.
