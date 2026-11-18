# Katana canvas: the design system

Status: **applied** (owner direction 2026-11-18). The owner chose a set of reference images (a floating canvas of connected cards, a right
column of tiles, a dot-matrix wordmark, a red sun) as "the ultimate visual reference for the Katana style", and asked for the full UI to be
remade in it. This document is the design system's single source for colours, corners and shadows. It supersedes those parts of
`KATANA_DESIGN_PLAN.md` and `MERIDIAN_MIXED_DESIGN_PLAN.md`; their rules on type, motion, state words and layout still hold where this
document does not change them. The tokens are in `docs/design/tokens/katana-tokens.json`; `src/styles.css` declares the same values, and
`src/lib/meridian/a11y/katana-tokens.test.ts` checks this document, the JSON and the stylesheet against each other.

## 1. The philosophy

1. **A room of tiles.** The page is a grey room (warm mid-grey in the light theme, near-black in the dark). Content sits on tiles: soft
   corners, a hairline edge and one soft shadow. A tile is the only container; a screen is a set of tiles, not a page of rules.
2. **Ink is the action.** The main action is an ink pill: black on the light room, white on the dark. Every button is a pill. Icon buttons
   are circles. A new thing is made with a square ink "+".
3. **Vermilion marks what needs you.** The accent is one vermilion (#D2462A light, #E0573A dark, or the reader's chosen preset). It marks
   the selected place and step, a count waiting for you, the focus ring, progress and the one hero element of a screen (the sun on the
   canvas). It is a fill, a dot or a disc, almost never text; where it is text it uses the darker or lighter text value.
4. **Things float.** The rail, the top bar's chips, menus, dialogs and the phone's dock float above the room with a soft shadow. Nothing
   glows.
5. **Figures in the dot face.** The wordmark and the big figures (a step count, a mode letter) are set in a 5 by 7 dot matrix. Numbers
   elsewhere stay in JetBrains Mono; text stays in Instrument Sans; page titles stay in Archivo.
6. **What stays from Katana.** A state is a dot and a word, never a tinted fill. Nothing pulses. Motion explains a change, and reduced
   motion removes it. Text is 11 px or larger. Every text colour meets 4.5:1 on every surface it is drawn on, and every control edge and
   graphic meets 3:1.

## 2. Colour

The table below is computed by the repository's own helper (`src/lib/meridian/a11y/contrast.ts`); the test recomputes every figure.

| Pair | Minimum | Dark | Light | Result |
| --- | --- | --- | --- | --- |
| fg-primary on bg-base | 4.5:1 | #F4F4F5 on #0D0D0E = **17.67:1** | #111113 on #D3D3D4 = **12.61:1** | pass |
| fg-primary on bg-raised | 4.5:1 | #F4F4F5 on #1C1C1E = **15.48:1** | #111113 on #F1F1F1 = **16.70:1** | pass |
| fg-primary on bg-overlay | 4.5:1 | #F4F4F5 on #242427 = **14.08:1** | #111113 on #F8F8F8 = **17.76:1** | pass |
| fg-secondary on bg-base | 4.5:1 | #C8C8CC on #0D0D0E = **11.65:1** | #2E2E32 on #D3D3D4 = **9.04:1** | pass |
| fg-secondary on bg-raised | 4.5:1 | #C8C8CC on #1C1C1E = **10.20:1** | #2E2E32 on #F1F1F1 = **11.97:1** | pass |
| fg-secondary on bg-overlay | 4.5:1 | #C8C8CC on #242427 = **9.28:1** | #2E2E32 on #F8F8F8 = **12.73:1** | pass |
| fg-muted on bg-base | 4.5:1 | #9C9CA2 on #0D0D0E = **7.11:1** | #46464B on #D3D3D4 = **6.27:1** | pass |
| fg-muted on bg-raised | 4.5:1 | #9C9CA2 on #1C1C1E = **6.23:1** | #46464B on #F1F1F1 = **8.31:1** | pass |
| fg-muted on bg-overlay | 4.5:1 | #9C9CA2 on #242427 = **5.67:1** | #46464B on #F8F8F8 = **8.84:1** | pass |
| accent-red-text on bg-base (the accent as text) | 4.5:1 | #EE7A5F on #0D0D0E = **7.02:1** | #922B15 on #D3D3D4 = **5.44:1** | pass |
| accent-red-text on bg-raised (the accent as text) | 4.5:1 | #EE7A5F on #1C1C1E = **6.15:1** | #922B15 on #F1F1F1 = **7.21:1** | pass |
| accent-red-text on bg-overlay (the accent as text) | 4.5:1 | #EE7A5F on #242427 = **5.59:1** | #922B15 on #F8F8F8 = **7.67:1** | pass |
| accent-red-text on bg-base (the accent as text) | 4.5:1 | #EE7A5F on #0D0D0E = **7.02:1** | #922B15 on #D3D3D4 = **5.44:1** | pass |
| on-accent on accent-red (label on the red fill) | 4.5:1 | #000000 on #E0573A = **5.59:1** | #000000 on #D2462A = **4.65:1** | pass |
| on-accent on accent-red-hover (label on the red fill, hover) | 4.5:1 | #000000 on #E9705A = **6.93:1** | #000000 on #DE5E43 = **5.79:1** | pass |
| fg-primary on accent-red-muted (selected row text) | 4.5:1 | #F4F4F5 on #2B1410 = **15.79:1** | #111113 on #F3D6CD = **13.75:1** | pass |
| bg-base on white-accent (label on a white fill (switch on-state, primary on white)) | 4.5:1 | #0D0D0E on #F4F4F5 = **17.67:1** | #D3D3D4 on #111113 = **12.61:1** | pass |
| success on bg-base | 4.5:1 | #3DDC84 on #0D0D0E = **10.89:1** | #0D5E2F on #D3D3D4 = **5.28:1** | pass |
| success on bg-raised | 4.5:1 | #3DDC84 on #1C1C1E = **9.54:1** | #0D5E2F on #F1F1F1 = **6.99:1** | pass |
| success on bg-overlay (added by the mixed plan: toasts and overlays) | 4.5:1 | #3DDC84 on #242427 = **8.67:1** | #0D5E2F on #F8F8F8 = **7.44:1** | pass |
| warning on bg-base | 4.5:1 | #FFB020 on #0D0D0E = **10.62:1** | #6F4600 on #D3D3D4 = **5.50:1** | pass |
| warning on bg-raised | 4.5:1 | #FFB020 on #1C1C1E = **9.30:1** | #6F4600 on #F1F1F1 = **7.29:1** | pass |
| warning on bg-overlay (added by the mixed plan: toasts and overlays) | 4.5:1 | #FFB020 on #242427 = **8.46:1** | #6F4600 on #F8F8F8 = **7.75:1** | pass |
| danger on bg-base | 4.5:1 | #FF5C75 on #0D0D0E = **6.51:1** | #9E1230 on #D3D3D4 = **5.43:1** | pass |
| danger on bg-raised | 4.5:1 | #FF5C75 on #1C1C1E = **5.70:1** | #9E1230 on #F1F1F1 = **7.20:1** | pass |
| danger on bg-overlay (added by the mixed plan: toasts and overlays) | 4.5:1 | #FF5C75 on #242427 = **5.19:1** | #9E1230 on #F8F8F8 = **7.66:1** | pass |
| info on bg-base | 4.5:1 | #5AA9FF on #0D0D0E = **7.91:1** | #0A4F94 on #D3D3D4 = **5.49:1** | pass |
| info on bg-raised | 4.5:1 | #5AA9FF on #1C1C1E = **6.93:1** | #0A4F94 on #F1F1F1 = **7.27:1** | pass |
| info on bg-overlay (added by the mixed plan: queued state in a drawer or toast) | 4.5:1 | #5AA9FF on #242427 = **6.31:1** | #0A4F94 on #F8F8F8 = **7.73:1** | pass |
| border-strong on bg-base (control edges) | 3:1 | #7A7A80 on #0D0D0E = **4.55:1** | #68686D on #D3D3D4 = **3.70:1** | pass |
| border-strong on bg-raised (control edges) | 3:1 | #7A7A80 on #1C1C1E = **3.99:1** | #68686D on #F1F1F1 = **4.91:1** | pass |
| border-strong on bg-overlay (added by the mixed plan: overlay edges) | 3:1 | #7A7A80 on #242427 = **3.63:1** | #68686D on #F8F8F8 = **5.22:1** | pass |
| accent-red on bg-base (focus ring and graphics) | 3:1 | #E0573A on #0D0D0E = **5.17:1** | #D2462A on #D3D3D4 = **3.02:1** | pass |
| white-accent on bg-base (switch, checkbox and progress fills) | 3:1 | #F4F4F5 on #0D0D0E = **17.67:1** | #111113 on #D3D3D4 = **12.61:1** | pass |
| danger on bg-base (icons) | 3:1 | #FF5C75 on #0D0D0E = **6.51:1** | #9E1230 on #D3D3D4 = **5.43:1** | pass |
| on-dock on dock (the phone's tab bar: the current place's label) | 4.5:1 | #F4F4F5 on #2A2A2D = **13.02:1** | #F4F4F5 on #111113 = **17.16:1** | pass |
| on-dock-muted on dock (the phone's tab bar: the other places' labels) | 4.5:1 | #ABABB0 on #2A2A2D = **6.26:1** | #ABABB0 on #111113 = **8.25:1** | pass |
| accent-red on dock (the phone's tab bar: the current place's disc) | 3:1 | #E0573A on #2A2A2D = **3.81:1** | #D2462A on #111113 = **4.18:1** | pass |

## 3. Corners and shadows

| Token | Value | Used for |
| --- | --- | --- |
| `--radius-sharp` | 12 px | inputs, menus' items, small cards; the class `rounded-sharp` keeps its name |
| `--radius-sm` | 10 px | small icon squares |
| `--radius-md` | 14 px | menus, popovers, tooltips (`.surface-menu`) |
| `--radius-lg` | 20 px | panels and tiles (`.panel`, `.surface-tile`, `.surface-flat`) |
| `--radius-xl` | 28 px | dialogs, sheets and frames (`.surface-dialog`, `.sheet-*`) |
| pill | `rounded-full` | buttons, chips, badges, tabs, the top bar's chips, the phone's dock |

| Token | Value | Used for |
| --- | --- | --- |
| `--shadow-sm` | `0 1px 2px rgb(0 0 0 / 0.06), 0 10px 24px -16px rgb(0 0 0 / 0.35)` | tiles and panels |
| `--shadow-md` | `0 18px 40px -24px rgb(0 0 0 / 0.45)` | menus and popovers |
| `--shadow-lg` | `0 32px 64px -28px rgb(0 0 0 / 0.55)` | dialogs, sheets, toasts, the phone's dock |

A shadow comes only from these tokens, through the surface classes; no screen writes a shadow utility. The video canvas has its own two
(`--kc-shadow`, `--kc-card-shadow`). `src/components/design-rules.test.ts` checks both rules.

## 4. Components

- **Buttons** (`ui/button.tsx`): pills. *Primary* is ink (`white-accent` fill, room-coloured label; hover is the secondary ink). *Secondary*
  is a tile pill with a hairline. *Quiet* is a bare pill that shows the overlay on hover. *Danger* is a danger outline pill.
- **Tiles** (`.panel`, `Card`): the raised surface, 20 px corners, hairline, small shadow. `Card elevation="flat"` drops the shadow;
  `floating` is the dialog surface.
- **Tabs** (`TabsList`): a segmented pill track on the raised surface; the active tab is an ink pill.
- **Badges** (`Badge`): a dot and a word. **Counts** (the rail, the bell, a waiting choice) are vermilion pills with a black figure.
- **Fields**: the overlay surface, 12 px corners, a strong edge (3:1). The focus ring is 2 px of the accent with a 2 px offset.
- **Menus, popovers, tooltips**: `.surface-menu`. **Dialogs**: `.surface-dialog`. **Sheets**: rounded on the edge that faces the page.
- **The canvas** (`components/canvas`): the reference itself, scoped to `.kc`; see `docs/MCP_CONNECTOR.md`, "The canvas".

## 5. The shell on a desktop

- **The rail** is a floating tile 12 px inside the window, 232 px wide (64 px collapsed). The workspace and brand switchers are pills at its
  top. The place you are in is an **ink pill**; its screens hang under it on a hairline, the current one on the overlay surface. The red
  meridian line of the earlier plan is no longer drawn: the floating rail has its own edge.
- **The top bar** is a frosted strip with two chips: the location (Workspace / brand / page) on the left, and a tile pill on the right
  that holds search, alerts (with a vermilion count), the theme and the account.

## 6. The design on a phone

The phone is designed first for the thumb and second for the eye, with the same tiles and ink as the desktop.

1. **One header row of chips.** A round menu button, the screen's name in the heading size, and the tools pill (search, alerts, theme,
   account). The location breadcrumb of the desktop is left out, so the header is one row and the page's own title starts under it.
2. **A floating dock for the five places.** The five places (Home, Create, Library, Insights, Settings) sit in an ink pill that floats
   12 px above the home indicator and the screen's edges, at most 448 px wide. Each place is a 56 px target with its icon and its label,
   so the bar is never icons alone. The place you are in sits on a **vermilion disc** with a bold label and is announced as the current
   page. A place with no screen yet is shown and marked unavailable. The page scrolls under the dock and has 128 px of room at its end, so
   the last control is never hidden.
3. **Tiles stack.** Every tile takes the width with a 16 px gutter; grids fall back to one column; tables become lists (`DataTable`'s card
   mode). Nothing scrolls sideways: the UI smoke test fails a page that does at 360 and 390 px.
4. **The canvas becomes the list.** On the video canvas, the board's cards stack in the snake's order with a dashed spine, and the right
   column's tiles follow them.
5. **Sheets come from the bottom.** Menus and pickers on a phone are bottom sheets with rounded top corners; side panels take the full
   width.
6. **Reach and focus.** Every target is at least 44 px on a touch screen; fields are 16 px so iOS does not zoom; the focus ring shows on the
   dock and on every chip.

## 7. Tokens

```css
/* Katana tokens: the canvas system (owner direction 2026-11-18). Generated from docs/design/tokens/katana-tokens.json. */
:root, :root[data-theme="dark"] {
  --bg-base: #0D0D0E;
  --bg-raised: #1C1C1E;
  --bg-overlay: #242427;
  --border-hairline: #2E2E32;
  --border-strong: #7A7A80;
  --fg-primary: #F4F4F5;
  --fg-secondary: #C8C8CC;
  --fg-muted: #9C9CA2;
  --accent-red: #E0573A;
  --accent-red-hover: #E9705A;
  --accent-red-text: #EE7A5F;
  --accent-red-muted: #2B1410;
  --on-accent: #000000;
  --white-accent: #F4F4F5;
  --success: #3DDC84;
  --warning: #FFB020;
  --danger: #FF5C75;
  --info: #5AA9FF;
  --scrim: rgb(0 0 0 / 0.6);
  --dock: #2A2A2D;
  --on-dock: #F4F4F5;
  --on-dock-muted: #ABABB0;
}
:root[data-theme="light"] {
  --bg-base: #D3D3D4;
  --bg-raised: #F1F1F1;
  --bg-overlay: #F8F8F8;
  --border-hairline: #BDBDC0;
  --border-strong: #68686D;
  --fg-primary: #111113;
  --fg-secondary: #2E2E32;
  --fg-muted: #46464B;
  --accent-red: #D2462A;
  --accent-red-hover: #DE5E43;
  --accent-red-text: #922B15;
  --accent-red-muted: #F3D6CD;
  --on-accent: #000000;
  --white-accent: #111113;
  --success: #0D5E2F;
  --warning: #6F4600;
  --danger: #9E1230;
  --info: #0A4F94;
  --scrim: rgb(20 20 22 / 0.4);
  --dock: #111113;
  --on-dock: #F4F4F5;
  --on-dock-muted: #ABABB0;
}
```
