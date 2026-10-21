# Katana design plan for Meridian

Status: draft for owner review. Written 2026-10-21 on branch run/factory-6h. This plan changes no app code. The files it creates are this document, `docs/design/tokens/katana-tokens.json` (item l asks for a JSON file), `docs/design/logo/meridian-logo.html` and four frames in `docs/design/logo/frames/`.

Katana is the visual system for Meridian: a black room, a red meridian, white for primary actions, hairline structure and no soft effects. It is built for people who run campaigns for hours. Every screen should say what it has, what it is missing and what runs now.

## a. Principles

Five principles. Each has a test a reviewer can apply to a screenshot or a diff.

1. **Black is the room. Red marks where attention is now.**
   Test: every red element on a screen is one of these: the focus ring; the current item in navigation or tabs; a selected row, card or step; a running step; an unread count; the viewport box on the canvas minimap; or the one accent action on the screen. A review fails any other red element, and fails a screen with two accent actions.
2. **Say what is missing, in words, where the work happens.**
   Test: every disabled control, empty state, not-connected step and error has visible text that names the missing item and the next step. The control points at that text with `aria-describedby`. Turn colour off (greyscale): every state still reads.
3. **Hairlines, not shadows.**
   Test: the finished migration has no `box-shadow` or `shadow-*` class with a blur radius. Surfaces are separated by `bg-raised`, `bg-overlay` and the border tokens. Overlays use a scrim and a 1 px `border-strong` edge.
4. **Every number says what it is.**
   Test: money and metrics use the mono face with tabular figures. An estimate starts with "est." and a recorded or actual value does not. A figure with no source shows the words "not recorded", never 0 and never a blank.
5. **Motion explains a state change. The logo is the only ambient motion.**
   Test: each animated element names the state it explains and has a row in the reduced-motion table in section e. With reduced motion emulated, no UI element animates. The logo shows one still frame.

## b. Colour

Dark is the primary theme and the default. Light is the counterpart, selected by `data-theme="light"`.

| Role | Dark | Light | Use |
|---|---|---|---|
| bg-base | #000000 | #FFFFFF | Page background. Dark is pure black, as the brief asks. |
| bg-raised | #0E0E0E | #F4F4F4 | Cards, panels, table headers, the canvas frame. |
| bg-overlay | #161616 | #FFFFFF | Menus, dialogs, palette, toasts, floating toolbars. Light overlays are white with a strong edge. |
| border-hairline | #262626 | #E2E2E2 | Dividers and card edges. Decorative only, so it has no contrast minimum. |
| border-strong | #6B6B6B | #767676 | Control edges (inputs, checkboxes, secondary buttons) and overlay edges. Meets 3:1. |
| fg-primary | #FFFFFF | #0A0A0A | Headings, values, labels in use. |
| fg-secondary | #C4C4C4 | #3D3D3D | Body copy, icons, unselected labels. |
| fg-muted | #949494 | #5E5E5E | Captions, placeholders, state words of planned or skipped items. |
| accent-red | #FF2E38 | #C8102E | The meridian: focus ring, current item, running step, selected row, unread count, one accent action per screen. |
| accent-red-hover | #FF5A63 | #A50D25 | Hover and pressed state of red fills and red text. |
| accent-red-muted | #2A0B0F | #FBE3E6 | Selected row background. Text on it stays fg-primary. |
| white-accent | #FFFFFF | #0A0A0A | Primary button fill, switch on-state, checkbox fill, progress fill. In light this is ink, because a white fill on a white page disappears. |
| success | #3DDC84 | #14703A | Done, healthy, approved. |
| warning | #FFB020 | #8A5A00 | Not connected, paused at budget, needs review. |
| danger | #FF4D6A | #B3133A | Failed, rejected, validation errors. Always with an icon and a word. |
| info | #5AA9FF | #0B5FB8 | Queued and informational notices. Running uses red, not info. |

**Two reds.** The dark red is too light for text on white: #FF2E38 on #FFFFFF is 3.68:1. The light theme therefore uses #C8102E (5.88:1 on white). Both are "accent-red" in the token names. Designers should treat them as one role.

**Red on black.** accent-red on bg-base is 5.70:1, and on bg-overlay 4.91:1. Both pass 4.5:1 for body text, so red text is not restricted to large text. It does not reach 7:1, so long red passages are avoided. Red text is used for short labels: state words, the active tab, error labels.

**Danger and red.** The danger rose (#FF4D6A, hue 350 degrees) sits 7 degrees from the accent red (hue 357 degrees). The rule that keeps them apart: danger always carries an icon and a word, and red never appears without a "now" meaning. Open question 4 asks whether the owner wants a more distant hue.

**No tinted status fills.** Status is a dot and a word, not a tinted background. This removes the `*-soft` tokens and avoids a second set of contrast pairs.

**Contrast.** Generated from `docs/design/tokens/katana-tokens.json` with the repo's own WCAG helper (`src/lib/meridian/a11y/contrast.ts`). The same figures came from an independent calculation. Thirty pairs, all in both themes:

| Pair (foreground on background) | Minimum | Dark: values and ratio | Light: values and ratio | Result |
|---|---|---|---|---|
| fg-primary on bg-base | 4.5:1 | #FFFFFF on #000000 = **21.00:1** | #0A0A0A on #FFFFFF = **19.80:1** | pass |
| fg-primary on bg-raised | 4.5:1 | #FFFFFF on #0E0E0E = **19.30:1** | #0A0A0A on #F4F4F4 = **18.00:1** | pass |
| fg-primary on bg-overlay | 4.5:1 | #FFFFFF on #161616 = **18.10:1** | #0A0A0A on #FFFFFF = **19.80:1** | pass |
| fg-secondary on bg-base | 4.5:1 | #C4C4C4 on #000000 = **12.04:1** | #3D3D3D on #FFFFFF = **10.86:1** | pass |
| fg-secondary on bg-raised | 4.5:1 | #C4C4C4 on #0E0E0E = **11.07:1** | #3D3D3D on #F4F4F4 = **9.88:1** | pass |
| fg-secondary on bg-overlay | 4.5:1 | #C4C4C4 on #161616 = **10.38:1** | #3D3D3D on #FFFFFF = **10.86:1** | pass |
| fg-muted on bg-base | 4.5:1 | #949494 on #000000 = **6.92:1** | #5E5E5E on #FFFFFF = **6.48:1** | pass |
| fg-muted on bg-raised | 4.5:1 | #949494 on #0E0E0E = **6.36:1** | #5E5E5E on #F4F4F4 = **5.90:1** | pass |
| fg-muted on bg-overlay | 4.5:1 | #949494 on #161616 = **5.97:1** | #5E5E5E on #FFFFFF = **6.48:1** | pass |
| accent-red on bg-base | 4.5:1 | #FF2E38 on #000000 = **5.70:1** | #C8102E on #FFFFFF = **5.88:1** | pass |
| accent-red on bg-raised | 4.5:1 | #FF2E38 on #0E0E0E = **5.24:1** | #C8102E on #F4F4F4 = **5.35:1** | pass |
| accent-red on bg-overlay | 4.5:1 | #FF2E38 on #161616 = **4.91:1** | #C8102E on #FFFFFF = **5.88:1** | pass |
| accent-red-hover on bg-base | 4.5:1 | #FF5A63 on #000000 = **6.89:1** | #A50D25 on #FFFFFF = **7.82:1** | pass |
| bg-base on accent-red | 4.5:1 | #000000 on #FF2E38 = **5.70:1** | #FFFFFF on #C8102E = **5.88:1** | pass |
| bg-base on accent-red-hover | 4.5:1 | #000000 on #FF5A63 = **6.89:1** | #FFFFFF on #A50D25 = **7.82:1** | pass |
| fg-primary on accent-red-muted | 4.5:1 | #FFFFFF on #2A0B0F = **18.21:1** | #0A0A0A on #FBE3E6 = **16.25:1** | pass |
| bg-base on white-accent | 4.5:1 | #000000 on #FFFFFF = **21.00:1** | #FFFFFF on #0A0A0A = **19.80:1** | pass |
| success on bg-base | 4.5:1 | #3DDC84 on #000000 = **11.77:1** | #14703A on #FFFFFF = **6.16:1** | pass |
| success on bg-raised | 4.5:1 | #3DDC84 on #0E0E0E = **10.82:1** | #14703A on #F4F4F4 = **5.60:1** | pass |
| warning on bg-base | 4.5:1 | #FFB020 on #000000 = **11.48:1** | #8A5A00 on #FFFFFF = **5.93:1** | pass |
| warning on bg-raised | 4.5:1 | #FFB020 on #0E0E0E = **10.56:1** | #8A5A00 on #F4F4F4 = **5.39:1** | pass |
| danger on bg-base | 4.5:1 | #FF4D6A on #000000 = **6.52:1** | #B3133A on #FFFFFF = **6.84:1** | pass |
| danger on bg-raised | 4.5:1 | #FF4D6A on #0E0E0E = **6.00:1** | #B3133A on #F4F4F4 = **6.22:1** | pass |
| info on bg-base | 4.5:1 | #5AA9FF on #000000 = **8.55:1** | #0B5FB8 on #FFFFFF = **6.28:1** | pass |
| info on bg-raised | 4.5:1 | #5AA9FF on #0E0E0E = **7.86:1** | #0B5FB8 on #F4F4F4 = **5.71:1** | pass |
| border-strong on bg-base | 3:1 | #6B6B6B on #000000 = **3.94:1** | #767676 on #FFFFFF = **4.54:1** | pass |
| border-strong on bg-raised | 3:1 | #6B6B6B on #0E0E0E = **3.62:1** | #767676 on #F4F4F4 = **4.13:1** | pass |
| accent-red on bg-base (focus ring and graphics) | 3:1 | #FF2E38 on #000000 = **5.70:1** | #C8102E on #FFFFFF = **5.88:1** | pass |
| white-accent on bg-base (graphics) | 3:1 | #FFFFFF on #000000 = **21.00:1** | #0A0A0A on #FFFFFF = **19.80:1** | pass |
| danger on bg-base (icons) | 3:1 | #FF4D6A on #000000 = **6.52:1** | #B3133A on #FFFFFF = **6.84:1** | pass |

Changes from the current palette: dark background moves from #0f0f0f to #000000; dark muted text is slightly darker (7.54:1 to 6.36:1 on the surface, still passing); the brass accent (#d6a064 dark, #8f6232 light) is retired and its roles are split between white-accent and accent-red.

Step kinds do not get colours. See section h.

## c. Typography

Three free faces, all under the SIL Open Font License 1.1. The licence texts are in the google/fonts repository, and the faces were confirmed on the Google Fonts CSS API with the axis ranges used here.

| Role | Face | Weights used | Why | Fallback stack |
|---|---|---|---|---|
| Display | Archivo | 600, 700 | A grotesque with a width axis (62 to 125). Headings look sharp and engineered without a second family. | `"Archivo", "Helvetica Neue", Arial, sans-serif` |
| Text | Instrument Sans | 400, 500, 600 | A compact, neutral text face. Its file lists `tnum` (checked in its GSUB table), so tables can align figures. It stays readable at 13 px. | `"Instrument Sans", "Segoe UI", system-ui, sans-serif` |
| Mono | JetBrains Mono | 400, 500 | Monospaced, so every digit aligns. Clear at 11 to 13 px for costs, model ids and counts. | `"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace` |

Not used as defaults: Inter, Roboto, Space Grotesk. Fraunces is retired with the serif wordmark. The current app loads Inter and Fraunces from npm packages; section m covers the swap.

**Type scale.** Sizes are in px, line heights in px.

| Token | Size / line | Weight | Tracking | Face | Used for |
|---|---|---|---|---|---|
| display-xl | 56 / 60 | 700 | -0.03em | display | Composer headline, desktop only |
| display-l | 36 / 40 from 768 px; 28 / 34 below | 600 | -0.02em | display | Page title (h1) |
| display-m | 22 / 28 | 600 | -0.01em | display | Section titles (h2) |
| heading | 16 / 22 | 600 | 0 | text | Card and step titles (h3) |
| body-l | 16 / 24 | 400 | 0 | text | Composer brief; input text on phones |
| body | 15 / 22 | 400 | 0 | text | Default text on desktop |
| body-strong | 15 / 22 | 600 | 0 | text | Emphasis; primary cell in a table |
| small | 13 / 20 | 400 | 0 | text | Table cells, hints, helper text |
| caption | 12 / 16 | 500 | 0 | text | Timestamps, meta, legend |
| label | 11 / 16 | 600 | +0.08em, uppercase | text | Eyebrows, column headers, state words. Four words at most. |
| button | 14 / 20 | 600 | 0 | text | All buttons |
| data-l | 28 / 32 | 500 | 0 | mono | Stat values, totals |
| data-m | 13 / 20 | 400 | 0 | mono | Costs in tables, numbers in cards |
| data-s | 11 / 16 | 500 | 0 | mono | Model ids, counts, chips |

Rules:
- Minimum text size is 11 px. The current app uses 10 px in the phone tab bar and some badges; both move to 11 px.
- Every number in the text face has `font-variant-numeric: tabular-nums`. Costs, ids and model names are always in the mono face.
- Inputs are 16 px on phones so the browser does not zoom on focus. They are 15 px on desktop.
- Long reading text is capped at `max-width: 65ch`, inside the 680 px reading column.

## d. Space, radius, borders, elevation

**Space.** One 4 px base scale. Tokens are `--space-N` where N times 4 is the value.

| Token | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16 | 20 | 24 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| px | 4 | 8 | 12 | 16 | 20 | 24 | 32 | 40 | 48 | 64 | 80 | 96 |

**Radius: 2 px.** Every surface and control uses 2 px. Round shapes are kept only for status dots, avatars, radio buttons, switch thumbs and the globe mark. Zero radius makes the outline of a focused control hard to see against a hairline. Four pixels starts to look like the soft cards the current app uses, which run from 6 to 12 px.

**Borders.** 1 px hairlines by default. Controls use 1 px `border-strong`. A selected row, card or step gets a 2 px accent-red mark on its left edge (top edge for a canvas step). Stale steps use a 2 px dashed `border-strong`. Focus is a 2 px accent-red outline with 2 px offset (section j).

**Elevation: none.** There is no `box-shadow`. A floating layer is `bg-overlay` with a 1 px `border-strong` edge. A modal sits over a scrim: rgba(0, 0, 0, 0.6) in dark, rgba(10, 10, 10, 0.4) in light. No blur. The shadow tokens (`--shadow-sm`, `--shadow-md`, `--shadow-lg`) are removed in migration step M6.

## e. Motion

**Durations.**

| Token | Value | Use |
|---|---|---|
| dur-fast | 120 ms | Hover and focus colour, press feedback in colour only |
| dur-base | 200 ms | Menus, tabs, toast entrance, a canvas step appearing, an edge drawing in |
| dur-slow | 360 ms | Dialogs and the command palette opening |
| dur-flip | 900 ms | One logo move, ease-in-out (the loop is four moves, 3600 ms) |

**Easings.**

| Token | cubic-bezier | Use |
|---|---|---|
| ease-standard | cubic-bezier(0.2, 0, 0, 1) | Entrances and state changes |
| ease-exit | cubic-bezier(0.4, 0, 1, 1) | Exits |
| ease-emphasis | cubic-bezier(0.65, 0, 0.35, 1) | Logo flips only |
| ease-linear | linear | Logo head travel, running dash, spinner |

**What animates.** Opacity for layers, 120 to 200 ms. A translate of up to 8 px for entering layers (toast, menu). `stroke-dashoffset` for an edge drawing in (200 ms) and for the running dash (linear, 800 ms per cycle). Spinner rotation (linear, 800 ms). The logo.

**What never animates.** Layout properties (width, height, top, left, margin, padding). `box-shadow`, `filter` and `backdrop-filter`. Scale, so no pop-in. Bounce or spring easing. Parallax and scroll-linked effects. Autoplaying video. Skeleton shimmer. Any loop except the logo and the running state. Page transitions longer than a 120 ms fade.

**Reduced motion.** Each row is one animated element.

| Element | Normal | Reduced motion |
|---|---|---|
| Layer entrance (menu, dialog, palette, toast) | Fade 120 ms with up to 8 px translate | Fade 120 ms, no translate |
| Button press | Colour change only; no translate | Same |
| Hover and focus colour | 120 ms | 120 ms (colour change is not motion) |
| Canvas step appearing | Fade and 4 px translate, 200 ms | Appears at once |
| Edge drawing in | Dash draws in 200 ms | Drawn at once |
| Running edge | Red dash moves | Static red dashed line |
| Running dot | Filled red dot | Same (no pulse, ever) |
| Spinner or loading ring | Rotates | Static ring beside the words "Working" |
| Skeleton | Static block | Static block |
| Tab underline | Changes at once | Same |
| Canvas zoom | Steps at once | Same |
| Command palette results | Appear at once | Same |
| Logo | 3.6 s loop | One still frame at t = 0 (the edge-on chop). Pause control hidden. The scrubber stays for manual review. |

The current global rule in `src/styles.css` cuts every transition to 0.01 ms. Katana keeps colour fades under reduced motion and removes only movement.

## f. Iconography and the logo system

**Icons.** lucide-react stays (already a dependency). 16 px icons at stroke 1.75; 20 px icons at stroke 1.5. Icons take the colour of their text (fg-primary, fg-secondary or fg-muted), or a status token when they carry status. No decorative colour. Step kinds keep their existing icons.

**The globe mark.** A sphere with five latitude circles (60 south, 30 south, equator, 30 north, 60 north) and six great-circle meridians spaced 30 degrees apart. Hairlines are fg-primary at 28% on the near side and 10% on the far side. A 1 px outline is at 35%. The red meridian is the arc from section g. Let D be the globe diameter. Stroke widths scale with D:

| Stroke | Width | Minimum |
|---|---|---|
| Hairline | D / 500 | 1 px |
| Arc head | D / 170 | 2 px |
| Arc tail | D / 600 | 0.8 px |
| Head dot radius | D / 160 | 2 px |

Three sizes of the mark exist. Use the largest that fits.

| Version | Diameter | What it draws |
|---|---|---|
| Full mark | 96 px and up | Everything above |
| Simplified mark | 24 px to 96 px | Outline, one equator ellipse, one meridian ellipse, the arc |
| Favicon | 16 px and 32 px | The pixel drawings below. Not scaled from the mark. |

**Static pose.** Every static lockup shows the mark at t = 0, the slice. The static logo is the half-cut globe.

**Clear space.** 0.25 D on all four sides, measured from the outline.

**Wordmark lockup.** Mark on the left, "Meridian" to its right in Archivo 600, sentence case, tracking -0.01em. The cap height of the wordmark is 0.5 D. The gap is 0.3 D. The mark and the wordmark are centred on each other vertically. Minimum lockup height is 24 px.

**One-colour version.** Every stroke and the arc in one solid colour (fg-primary on dark, ink on light). Hairlines are drawn at D / 700 so the arc still reads. Used for print, embossing and red fills (use white-accent on a red fill, never the red mark on red).

**Light-background version.** Ink hairlines (#0A0A0A at 28% and 10%) and the light accent red (#C8102E). No other colour.

**Favicon at 32 px** (tested in Chromium at 1x and 2x on black and white):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="2" fill="#000000"/>
  <circle cx="16" cy="16" r="11" fill="none" stroke="#FFFFFF" stroke-opacity="0.6" stroke-width="1.25"/>
  <ellipse cx="16" cy="16" rx="11" ry="3.4" fill="none" stroke="#FFFFFF" stroke-opacity="0.35" stroke-width="1"/>
  <ellipse cx="16" cy="16" rx="5.2" ry="11" fill="none" stroke="#FFFFFF" stroke-opacity="0.35" stroke-width="1"/>
  <line x1="16" y1="4.6" x2="16" y2="27.4" stroke="#FF2E38" stroke-width="2" stroke-linecap="round"/>
</svg>
```

**Favicon at 16 px** (the same test; the globe reads as a grey circle with a red line):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <rect width="16" height="16" rx="1" fill="#000000"/>
  <circle cx="8" cy="8" r="5.6" fill="none" stroke="#FFFFFF" stroke-opacity="0.6" stroke-width="1"/>
  <line x1="8" y1="2.4" x2="8" y2="13.6" stroke="#FF2E38" stroke-width="1.5" stroke-linecap="round"/>
</svg>
```

The favicon is a black square with a 2 px corner, so it reads on light and dark browser tabs.

**Where the mark appears today, and what replaces each.**
- `src/components/shell.tsx`: a brass "M" tile next to a Fraunces "Meridian". Replaced by the wordmark lockup.
- `src/components/settings/auth-shell.tsx`: `MeridianMark`, an older 32 px drawing with the brass accent. Replaced by the globe mark (simplified at 32 px).
- `public/favicon.svg`: a brass line and a green dot on a pale disc, inside a dark green square. Replaced by the 32 px drawing above; a 16 px file is added for browsers that use it.
- `public/manifest.webmanifest`: `background_color` and `theme_color` are #f6f4ee. Becomes #000000 (dark is the default).
- `src/routes/__root.tsx`: `theme-color` meta is #f3f0e7. Becomes #000000.
- `public/og.jpg`: cream paper with a serif MERIDIAN wordmark. The app's head tags do not reference it. Check where it is used before replacing it. Open question 13.

**Do not.** Add glow, gradient, bevel or drop shadow to the mark. Add a second colour. Rotate the static mark. Put the mark inside a coloured tile except for the favicon. Stretch it. Use the red arc anywhere else in the mark system.

## g. Logo motion spec

The prototype is `docs/design/logo/meridian-logo.html`: one self-contained WebGL 2 file, with no libraries and no network. Every value sits in one `CONFIG` object at the top of the script.

**The mark.** A see-through wireframe globe: three latitudes and four meridians, one every 45 degrees. A thin silhouette outlines it. The near lines are full strength and ease down to 16% on the far side. Around it runs the meridian, a red comet of light: a lit 3D tube with a hot white core at its head and a trail that fades to a faint full ring, so the circle always reads. Where the comet's plane cuts the globe, the grid lines light up red, most strongly near the head. A thin horizontal light streak passes through the head, and a bloom pass gives the red its glow.

**The motion: the globe spins and carries its meridian.** The globe turns about its own polar axis, one turn per 6 s loop. The red meridian is one of its own meridian lines, so it turns with it. From the front it starts edge-on, a slice through the globe, and opens into the full circle as the globe turns. A faint copy of the whole meridian stays visible. A comet of light runs along it three times per loop. Its trail lies on the meridian itself, along the stretch the head covered over the last 1.1 s, so the whole comet stays on the line as the globe turns.

**The side view.** The comet runs at one steady speed, three laps per loop, with a trail of fixed length; nothing in it ever resets. As the comet passes the bottom of the meridian, the camera swings round to face the meridian side-on, so it lies on the globe's outline. The bottom pole stays put on screen, so the comet carries on from the same point and traces the edge like a loading ring. One lap later, as it passes the bottom again, the camera swings on round to the front. Each swing takes 0.5 s on cubic-bezier(0.65, 0, 0.35, 1), centred on the bottom pass. The camera turns one way only, from the front to the side and on round to the front again, so the loop closes without a seam. The swings are placed so both turn the camera the same distance (120 degrees), and the camera blends its angles, not its position, so it never flips.

**Camera.** A perspective view with a 30 degree field of view, 5 globe radii away and about 19 degrees above the equator, so the latitudes curve.

**Files.**
- `meridian-logo-mark.png`: the hero still at t = 4.5 s, in the side view, 1440 px.
- `meridian-logo.gif`: 150 frames at 25 fps, 480 px.
- `meridian-logo.mp4`: the same frames at 600 px.
- `frames/`: four reference stills at 600 px: the front view (t = 0), the bottom pass as the view swings (3.5 s), the side view (4.5 s) and the bottom pass as it swings back (5.5 s).

**Controls and hooks.** Pause/Play, and a "freeze at t" slider. Open `?theme=light` for the light variant (no streak), and `?t=2.4` to freeze at a time. Reduced motion draws the ring pose as a still. `window.meridianMark.frame(t)` is pure, and `window.meridianMark.setTime(s)` freezes the frame.

**Checks.** All 150 frames rendered in headless Chromium (software WebGL) with no console errors. Eight moments across the loop were reviewed in a contact sheet. Not checked: the light variant, reduced motion and Pause, and how it looks on a hardware GPU.

## h. Components with states

Eight states for each component: default, hover, focus-visible, active, selected, disabled, loading, error. "n/a" means the state cannot occur for that component. Every red focus ring is 2 px accent-red with a 2 px offset, except on a red fill, where it is white-accent.

**Buttons**

| Variant | Default | Hover | Focus-visible | Active | Selected | Disabled | Loading | Error |
|---|---|---|---|---|---|---|---|---|
| Primary | white-accent fill, bg-base label, 40 px high (44 on touch), 2 px radius | Fill fg-secondary | Red outline | Fill fg-muted | n/a | No fill, 1 px border-hairline, fg-muted label, reason text beside it | Label stays; ring turns (static under reduced motion); aria-busy | n/a: the error appears beside the button |
| Accent (one per screen) | accent-red fill, bg-base label | Fill accent-red-hover | White-accent outline (not red on red) | Fill accent-red-hover with a 1 px bg-base inset | n/a | As Primary | As Primary | n/a |
| Secondary | Transparent, 1 px border-strong, fg-primary label | Fill bg-raised | Red outline | Fill bg-overlay | n/a | 1 px border-hairline, fg-muted label | As Primary | n/a |
| Quiet | No border, fg-secondary label | Fill bg-raised, fg-primary label | Red outline | Fill bg-overlay | Current page: fg-primary label and 2 px red left mark | fg-muted label | As Primary | n/a |
| Danger | 1 px danger border, danger label, transparent | Fill bg-raised | Red outline | Fill bg-overlay | n/a | As Disabled | As Primary | n/a |

**Inputs and selection controls**

| Control | Default | Hover | Focus-visible | Active | Selected | Disabled | Loading | Error |
|---|---|---|---|---|---|---|---|---|
| Text field, textarea, number | bg-base, 1 px border-strong, fg-primary text, label above in fg-secondary | Border fg-secondary | Red outline; border fg-primary | Border fg-primary while typing | n/a | 1 px border-hairline, fg-muted text, reason under the label | "Checking" caption (static) | Border danger; icon and message under the field; aria-invalid |
| Select (styled list) | Field style with chevron | Border fg-secondary | Red outline | Open list: bg-overlay, 1 px border-strong, items 36 px (44 on touch) | Item: check icon, 2 px red left mark, fg-primary | As field | "Loading options" text in the list | Message under the field |
| Switch | Track 40 by 20 px, bg-raised, 1 px border-strong; fg-secondary thumb at left | Track border fg-secondary | Red outline | Thumb grows to 18 px | On: track white-accent, bg-base thumb at right | Track border-hairline, fg-muted thumb | "Saving" caption beside it (static) | Track border danger; message |
| Checkbox | 16 px square, 1 px border-strong, 2 px radius | Border fg-primary | Red outline | Fill fg-muted while pressed | Checked: white-accent fill, bg-base tick; indeterminate: bar | Border-hairline | n/a | Border danger |
| Radio | 16 px circle, 1 px border-strong | Border fg-primary | Red outline | n/a | 6 px white-accent dot | Border-hairline | n/a | Border danger |

**Chips, tabs, cards and tables**

| Component | Default | Hover | Focus-visible | Active | Selected | Disabled | Loading | Error |
|---|---|---|---|---|---|---|---|---|
| Filter chip | 24 px high, 1 px border-hairline, caption-size fg-secondary label | Border border-strong | Red outline | Fill bg-overlay | Border fg-primary, fg-primary label | fg-muted label | n/a | Border danger and message |
| Status chip | 20 px high; 6 px dot in the status token; fg-primary label (danger label on failed) | n/a: not interactive | n/a | n/a | n/a | Hollow fg-muted dot for "planned" | n/a | Danger dot and label |
| Tab | body-strong fg-secondary label; 44 px high on touch | Label fg-primary | Red outline | Label fg-primary | 2 px red underline, fg-primary label | fg-muted label | Panel shows static skeleton | Message in the panel |
| Card | bg-raised, 1 px border-hairline, 16 px padding on phones and 24 px on desktop | Border border-strong (only if clickable) | Red outline (only if clickable) | Fill bg-overlay | 2 px red left mark, border border-strong | fg-muted text; no hover | Static skeleton bars | Border danger and an error notice |
| Table row | 40 px high (48 on touch), 1 px border-hairline bottom | Fill bg-raised | 2 px red inset outline on the row | Fill bg-overlay | accent-red-muted fill and 2 px red left mark | fg-muted text | Four static bars | Error card in place of the table |
| Table header | label style in fg-muted on bg-base, 1 px border-hairline bottom | Sort control turns fg-primary | Red outline | n/a | Sorted column fg-primary, 12 px arrow | n/a | n/a | n/a |

Numbers in tables are right-aligned, in the mono face, with tabular figures.

**Navigation and overlays**

| Component | Default | Hover | Focus-visible | Active | Selected | Disabled | Loading | Error |
|---|---|---|---|---|---|---|---|---|
| Side navigation item | 36 px high (44 on touch), 14 px fg-secondary label, 16 px icon | Fill bg-raised, fg-primary label | 2 px red inset outline | Fill bg-overlay | Current page: fg-primary label, 2 px red left mark, fill bg-raised | Shown, never greyed out; the reason is on the destination page | Count shows a static "..." | n/a |
| Top bar | bg-base, 56 px high, 1 px border-hairline bottom; breadcrumb in fg-muted with a border-strong "/" | Icon buttons fill bg-raised | Red outline | Fill bg-overlay | Current page name in fg-primary | n/a | n/a | Unread alert count is an accent-red chip |
| Command palette | Scrim; bg-overlay panel, 640 px max, 1 px border-strong, 48 px input | Row fill bg-raised | Red outline on the input | n/a | Highlighted row: bg-raised fill and 2 px red left mark | Row in fg-muted with reason on the right | Static "Searching" text | One line in danger above the list |
| Dialog and sheet | Scrim; bg-overlay, 1 px border-strong, 2 px radius, 24 px padding | n/a | Focus goes to the title or first field; red outline | n/a | n/a | Primary button disabled, with reason | Confirm button shows static "Working" | Message in the dialog; destructive confirm is a danger outline, never a red fill |
| Toast | bg-overlay, 1 px border-strong, 2 px status bar on the left (success, warning, danger, info) | Timer pauses | Red outline on the close control | n/a | n/a | n/a | Static "Working" text | Danger bar, icon and text; stays until closed |
| Empty state | Caption label, display-m title, one sentence naming what is missing, one action; no icon bubble | Action follows its button | Red outline on the action | n/a | n/a | n/a | Static skeleton | Replaced by the error state |
| Error state | 1 px danger border; heading; message; retry button; request id in caption | n/a | Red outline on retry | n/a | n/a | n/a | n/a | This is the error state |

**Orchestrator step cards (nodes, ports, edges).** A node is 232 by 132 px, with the existing geometry from `src/engine/orchestrator/layout.ts`: column gap 96 px, row gap 28 px. The header row holds the kind icon and label on the left, and the state word on the right. The title is one line. The model id is in the mono face, or "No model call". The footer holds the cost. A reason line appears for failed, not-connected and paused states, and may run to two lines so the cause is never cut off.

| Node state | Border and top mark | State word and dot | Reason line | Motion |
|---|---|---|---|---|
| Planned (default) | 1 px border-hairline | "PLANNED"; hollow fg-muted dot | None | None |
| Running | 1 px border-hairline, 2 px red top mark | "RUNNING"; filled red dot | None | Incoming edge's red dash moves; static under reduced motion |
| Done | 1 px border-hairline | "DONE"; filled success dot | None; cost is the recorded value | None |
| Reused (cache hit) | 1 px border-hairline | "REUSED"; hollow success dot | None | None |
| Skipped | 1 px border-hairline; title in fg-muted | "SKIPPED"; hollow fg-muted dot | The engine's reason, when there is one | None |
| Failed | 1 px danger border | "FAILED" with a cross icon, danger | The engine's reason (required) | None |
| Not connected | 1 px border-strong | "NOT CONNECTED" in warning, with a plug icon | Names the connection that makes the step run | None |
| Paused at budget | 1 px border-hairline | "PAUSED AT BUDGET" in warning | Names the budget and what raises it | None |
| To re-run (stale) | 2 px dashed border-strong | "TO RE-RUN" in fg-secondary (no colour) | None | None |
| Hover | Border border-strong | Unchanged | Unchanged | None |
| Focus-visible | 2 px red outline, 2 px offset | Unchanged | Unchanged | None |
| Selected (open in details) | Border fg-primary and 2 px red top mark | Unchanged | Unchanged | None |

Ports: an input port is an 8 px circle with a 1 px border-strong ring on bg-base. An output port is an 8 px circle filled fg-secondary. A port grows to 10 px on hover. Ports are not focusable; the card is. On a selected card, its ports fill fg-primary.

Edges: 1.5 px. Planned and skipped edges are fg-muted. Done and reused edges are fg-secondary. A running edge is a red dash (6 px dash, 4 px gap) that moves. A failed edge is solid danger. A stale edge is a dashed border-strong (4 px dash, 4 px gap). An edge draws in over 200 ms when it first appears.

Step kinds (Reference, Analysis, Script, Still, Shot, Voice, Presenter, Edit, Compose, Render) keep their labels and icons from `src/components/content-factory/orchestrator-presentation.ts`. Their colours are removed, so colour carries state only. The canvas legend lists the states and the ten kinds.

## i. Layout

**Breakpoints.** The same as the current app, which uses Tailwind's defaults.

| Name | Width | What changes |
|---|---|---|
| phone | below 640 px | Single column; 16 px gutter; bottom tab bar; sheets for navigation |
| sm | 640 px | 24 px gutter; two-column forms where they fit |
| md | 768 px | Tables appear in place of stacked cards; display-l title size |
| lg | 1024 px | Side navigation appears; 32 px gutter |
| xl | 1280 px | Top bar shows the role |

**Gutter.** 16 px on phones (required by the brief), 24 px from 640 px, 32 px from 1024 px. The page never scrolls horizontally. Only a canvas, or a table on a phone, scrolls inside its own frame.

**Widths.** Data screens: 1200 px maximum content width. Reading and forms: 680 px (the composer, settings forms). The canvas uses the full content width and scrolls inside its frame.

**Shell.** Side navigation 240 px wide (64 px collapsed). Top bar 56 px. Phone bottom bar 56 px plus the bottom safe-area inset, with four destinations and a More slot. Content on phones has 88 px of bottom padding so the bar never covers it.

**Canvas workspace.**
- Toolbar: floats 12 px inside the top-left corner of the canvas frame. 36 px high, bg-overlay, 1 px border-strong, 2 px radius. Controls: zoom out, zoom level (data-s mono), zoom in, fit to width, minimap toggle, and the replay status ("N of M events drawn"). Controls are 32 px, or 44 px on touch.
- Zoom steps: 50, 75, 100, 125 and 150 percent, as in `ZOOM_STEPS`. Fit to width is the default on load.
- Minimap: bottom-right, 180 by 112 px, bg-raised, 1 px border-hairline. Steps are 1 px border-strong rectangles. The visible area is a 1.5 px accent-red box, because it is where the person is.
- Background: 24 px dot grid in border-hairline (the old grid was 20 px).
- Keyboard: arrow keys pan when the canvas has focus; plus and minus zoom; zero fits. Tab walks the steps in reading order (column by column, top to bottom, as now). Enter opens a step's details.
- Phones: the toolbar stays pinned at the top of the canvas frame. The frame scrolls both ways. The page itself does not.

**Starting screen (composer).**
- Desktop: a centred column 680 px wide. The display-xl headline sits above a brief box: bg-raised, 1 px border-strong, 2 px radius, body-l text, minimum 160 px high.
- Below the box: the four example goals from `EXAMPLE_GOALS` as chips. A click fills the goal field and nothing else.
- Below the chips: a row with brand, format and budget (mono, with a dollar prefix), then the primary button "Plan the run" in white-accent.
- The button is disabled until `missingFields` is empty. The reason sits under the row in fg-muted, and lists the missing items in the order the form asks for them (`listWords`).
- Phones: one column, 16 px gutter. The primary action is a full-width bar fixed above the bottom tab bar, with its reason above it.
- The composer is prompt-first, one brief and one action. It runs no step. That matches the existing behaviour in `orchestrator-composer.tsx`.

## j. Accessibility

- **Contrast.** Section b lists all thirty pairs. Every text pair is at least 4.5:1 and every control edge and focus ring at least 3:1, in both themes.
- **Focus ring.** A 2 px accent-red outline with a 2 px offset, on bg-base or bg-raised. It is 5.70:1 on black and 5.88:1 on white. On a red fill the ring is white-accent, so it does not merge with the fill. The outline is never removed.
- **Colour.** Colour is never the only signal. Every state has a word, a shape and a colour: a filled, hollow, crossed or dashed mark, plus the word.
- **Touch targets.** 44 px on coarse pointers (the existing `pointer-coarse` variant). At least 8 px between adjacent targets. The 16 px checkbox and radio keep a 44 px hit area through the existing `touch-hit-44` class.
- **Keyboard map.**

| Key | Where | Action |
|---|---|---|
| Ctrl/Cmd + K | Anywhere | Open the command palette |
| / | Brand pages | Focus search |
| ? | Anywhere outside a text field | Keyboard shortcuts |
| G then O, S, R, I, L, F, A | Brand pages | Go to Overview, Studio, Reviews, Intelligence, Learning, Factory, Accounts |
| Tab, Shift+Tab | Everywhere | Move between controls in reading order |
| Arrow keys | Lists, menus, tabs, palette | Move the highlight |
| Enter / Space | Controls | Activate |
| Esc | Overlays | Close and return focus to the trigger |
| Arrow keys, + and -, 0 | Canvas (focused) | Pan, zoom, fit |
| Enter | Canvas step | Open the step's details |

- **Screen reader labels.** A step card is named by its kind, title, state, model and cost, in that order (the existing `stepName`). A cost is read as "estimated" or "recorded", followed by dollars, for example "estimated cost 0.0120 US dollars". Icon-only buttons have labels. Run progress announces politely; a failure announces once per run.
- **Reduced motion.** Section e.
- **More contrast.** When the person asks for more contrast, `border-hairline` becomes `border-strong` and `fg-muted` becomes `fg-secondary`.
- **Reflow.** Layouts work at 320 px wide and at 200 percent zoom without horizontal page scrolling. No fixed height clips text.

## k. Benchmark notes

These notes come from prior knowledge of each product. The current interfaces were not reviewed for this plan, and no statistics are quoted.

- **Higgsfield, canvas and mobile composer.** Take: a node canvas where the flow is the main object, and a prompt-first starting screen that reads top to bottom on a phone. Do not take: its saturated gradient treatment, glow effects or any of its illustration or trade dress.
- **Linear.** Take: dense lists with hairline separators; keyboard-first commands; state shown as small dots and words. Do not take: its purple accent, its type setup or its wording.
- **Vercel.** Take: a black canvas with hairline borders; technical values in a monospace face; state beside a dot. Do not take: its logo, its triangle motif or its typography.
- **Raycast.** Take: a command palette with grouped results, keyboard hints and compact rows. Do not take: its icon set, its extension UI or its branded copy.
- **Arc.** Take: restraint in motion: few transitions, all short. Do not take: sidebar gestures or a pastel palette.
- **Apple's pro apps.** Take: dense inspectors with clear focus, and figures in a tabular face. Do not take: skeuomorphic chrome, Apple iconography or the system font.

## l. Token file

The CSS block below is generated from `docs/design/tokens/katana-tokens.json`. The JSON file has the same keys without the leading `--`, plus the thirty contrast pairs in section b with their minimums. The app can import the JSON later. The CSS shows the custom properties on `:root`, with dark as the default and light under `[data-theme="light"]`.

```css
/* Katana tokens. Source: docs/design/tokens/katana-tokens.json. Dark is the default. */
:root, :root[data-theme="dark"] {
  color-scheme: dark;
  --bg-base: #000000;
  --bg-raised: #0E0E0E;
  --bg-overlay: #161616;
  --border-hairline: #262626;
  --border-strong: #6B6B6B;
  --fg-primary: #FFFFFF;
  --fg-secondary: #C4C4C4;
  --fg-muted: #949494;
  --accent-red: #FF2E38;
  --accent-red-hover: #FF5A63;
  --accent-red-muted: #2A0B0F;
  --white-accent: #FFFFFF;
  --success: #3DDC84;
  --warning: #FFB020;
  --danger: #FF4D6A;
  --info: #5AA9FF;
  --font-display: "Archivo", "Helvetica Neue", Arial, sans-serif;
  --font-text: "Instrument Sans", "Segoe UI", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --radius-sharp: 2px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;
  --space-20: 80px;
  --space-24: 96px;
  --dur-fast: 120ms;
  --dur-base: 200ms;
  --dur-slow: 360ms;
  --dur-flip: 900ms;
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --ease-exit: cubic-bezier(0.4, 0, 1, 1);
  --ease-emphasis: cubic-bezier(0.65, 0, 0.35, 1);
  --ease-linear: linear;
}

:root[data-theme="light"] {
  color-scheme: light;
  --bg-base: #FFFFFF;
  --bg-raised: #F4F4F4;
  --bg-overlay: #FFFFFF;
  --border-hairline: #E2E2E2;
  --border-strong: #767676;
  --fg-primary: #0A0A0A;
  --fg-secondary: #3D3D3D;
  --fg-muted: #5E5E5E;
  --accent-red: #C8102E;
  --accent-red-hover: #A50D25;
  --accent-red-muted: #FBE3E6;
  --white-accent: #0A0A0A;
  --success: #14703A;
  --warning: #8A5A00;
  --danger: #B3133A;
  --info: #0B5FB8;
}
```

Notes for the import later. The Tailwind theme can map these with `@theme inline`, for example `--color-bg: var(--bg-base)`. The app's dark variant must match `[data-theme="dark"]` (section m, step M1).

## m. Migration plan

**Starting point.** Counts are from `src/` production files at the time of writing (tests excluded).

| Current pattern | Files | Uses | Where it matters |
|---|---|---|---|
| `surface-2` | 58 | 95 | Hover states, table headers, skeletons, avatars, chips |
| `bg-surface` | 80 | 175 | Panels and controls. Maps to `bg-raised` or `bg-base`. |
| `border-border` | 82 | 201 | Maps to `border-hairline` |
| `bg-accent` | 15 | 26 | Primary buttons, active tabs, progress, badges. Must be split. |
| `text-accent` | 10 | 14 | Active nav, emphasis. Becomes red only when it marks "now". |
| `border-accent` | 8 | 9 | Tabs, checkboxes, switches |
| `accent-soft` | 10 | 12 | Selected rows and menu items. Becomes `accent-red-muted`. |
| `accent-fg` | 8 | 9 | Labels on accent fills. Becomes `bg-base`. |
| `*-soft` (status tints) | 23 | 45 | Badges and banners. Replaced by dot and text. |
| `rounded-full` | 31 | 65 | Each use is classified: keep for dots, avatars, radios and switch thumbs; the rest become 2 px. |
| `rounded-md` / `-lg` / `-xl` | 55 / 30 / 15 | 103 / 41 / 19 | Become `rounded-sharp` |
| `shadow-*` | 12 | 20 | Removed; layers use borders |
| `backdrop-blur` | 2 | 3 | Removed (top bar, phone bottom bar) |
| `animate-*` | 7 | 11 | Reviewed against section e |
| `var(--color-*)` in TSX | 8 | 21 | Must move to the new names before the legacy names are removed |
| `text-[10px]` / `text-[11px]` | 7 | 16 | Minimum 11 px |
| `font-wordmark` | 2 | 2 | Shell wordmark and auth shell |
| `richColors` (sonner) | 1 | 1 | `feedback.tsx`; replace with Katana colour variables |
| `font-mono` | 36 uses | | Keeps working; the mono face becomes JetBrains Mono, self-hosted |

**Legacy names to Katana roles** (`src/styles.css`, `@theme` and `.dark` blocks):

| Legacy token (dark value) | Katana role | Note |
|---|---|---|
| `--color-bg` (#0f0f0f) | bg-base (#000000) | Background becomes pure black |
| `--color-surface` (#171717) | bg-raised (#0E0E0E) | Panels get darker, which needs a visual check |
| `--color-surface-2` (#1f1f1f) | bg-overlay for hover and menus; bg-raised for skeletons and headers | Decide per use (58 files) |
| `--color-border` (#2e2e2e) | border-hairline (#262626) | |
| `--color-border-strong` (#7d7d7d) | border-strong (#6B6B6B) | |
| `--color-fg` (#f2f2f2) | fg-primary (#FFFFFF) | |
| `--color-fg-muted` (#a8a8a8) | fg-muted (#949494) | Slightly darker; still 6.36:1 on raised |
| `--color-accent` (#d6a064) | Split: white-accent for primary fills, accent-red for "now" | Largest change; see M2 |
| `--color-accent-fg` (#1a1208) | bg-base | Black label on red and white fills |
| `--color-accent-soft` (#2b2116) | accent-red-muted | Selected rows only |
| `--color-brass-text`, `--color-brass` | Removed | Two files use them |
| `--color-success`, `-warning`, `-danger`, `-info` | Same names, new values | The `-soft` variants are removed |
| `--shadow-sm`, `-md`, `-lg` | Removed | |
| `--radius-sm` to `--radius-xl` | `--radius-sharp` (2 px) | |
| `--font-sans` (Inter), `--font-wordmark` (Fraunces) | `--font-text`, `--font-display` | |

**Coordination.** When this plan was written, `src/components/content-factory/` had uncommitted edits from another agent: `orchestrator-canvas.tsx`, `orchestrator-plans.tsx`, `orchestrator-screen.tsx`, `src/engine/orchestrator/layout.ts`, and the new `orchestrator-canvas-parts.tsx`, `orchestrator-composer.tsx`, `orchestrator-presentation.ts` and its test. Those files are now committed at `d3a5e57`, and the working tree is clean apart from this plan. Before M4, the lead should confirm that nothing is in flight in that folder. This plan does not touch those files.

**Phases.** Each phase is one branch and one PR (AGENTS rule 10). Each UI phase includes before and after screenshots.

**M0. Tokens and fonts. No visual change.**
- Files: `src/styles.css` (add the Katana custom properties beside the legacy names); `public/fonts/` (self-hosted woff2 for Archivo, Instrument Sans and JetBrains Mono; OFL licence files kept alongside); `@font-face` rules in `styles.css`.
- Change: adds tokens and fonts. Nothing uses them yet.
- What breaks: nothing visible. The new font files add weight to the first load; check it.
- Test: `npm test` (the two token tests still pass because the legacy names are kept); a load check that the three faces resolve in Chromium.

**M1. Dark by default and the theme attribute.**
- Files: `src/components/ui/theme.tsx` (applies `.dark` today; move to `data-theme` on `<html>`, dark default); `themeBootstrap` in the same file, injected by `src/routes/__root.tsx`; the `@custom-variant dark` line and `.dark` block in `styles.css`; the dark preview section of `src/routes/[_design].tsx` (uses `className="dark ..."`).
- Change: the default theme becomes dark. Open question 1 decides whether "system" still follows the operating system.
- What breaks: every person with a light system setting sees dark; the `prefers-contrast: more` block targets `.dark` and `:root:not(.dark)`; `src/components/ui/tokens.test.ts` reads the `.dark {` block and `--color-*` names.
- Test: update `tokens.test.ts` and `src/styles.contrast.test.ts` in the same PR (read the JSON, check its thirty pairs); `npm run typecheck`; `/_design` in both themes.

**M2. Primitives.** Button, controls, card, badge, tabs, feedback, data table and layout.
- Files: `src/components/ui/button.tsx` (primary becomes white-accent; new Accent variant; remove the press translate); `controls.tsx` (remove the switch and slider shadows; 16 px checkbox with a 44 px hit area); `primitives.tsx` (overlay and menu shadows removed; tabs use the red underline; progress uses white-accent); `card.tsx` (three elevations become two, both without shadow); `badge.tsx` (dot and text, no tinted fills); `feedback.tsx` (empty state without the icon bubble; skeleton without `animate-pulse`; sonner colours); `data-table.tsx` (selected rows use `accent-red-muted`); `layout.tsx` (`Stat` uses the mono data token; `Stepper` current step uses red).
- Change: the visible system changes here. Every screen that uses these components changes at once.
- What breaks: any screen that used the brass accent as "primary" now uses white; any screen that used accent for a non-"now" meaning must be reviewed (grep `bg-accent` and `text-accent`, 15 and 10 files); the sonner `richColors` look changes.
- Test: `npm run ui:design-smoke` (the `/_design` page at 390, 768 and 1440 px, with axe); `npm run ui:button-audit`; a reduced-motion emulation pass; before and after screenshots of the specimen page.

**M3. Shell and marks.**
- Files: `src/components/shell.tsx` (side navigation, top bar, phone bottom bar, wordmark, unread count, `backdrop-blur` removed); `src/components/command-palette.tsx` (`rounded-xl` and `shadow-lg` removed; highlight rule); `src/components/settings/auth-shell.tsx` (`MeridianMark` replaced); `public/favicon.svg` (32 px drawing; add a 16 px file); `public/manifest.webmanifest`; `src/routes/__root.tsx` (`theme-color` meta). New: one shared mark component that draws the simplified and full marks from the same geometry as the prototype. The mark is not `src/components/brand-mark.tsx`, which shows a client's logo.
- Change: one mark everywhere; the shell chrome follows section h.
- What breaks: the sidebar wordmark width on narrow screens; the favicon on existing installs (browsers cache icons).
- Test: keyboard map (section j), with the palette keys; favicon at 16 and 32 px; the auth screen in both themes; `og.jpg` decision (open question 13).

**M4. Content Factory and orchestrator.** Starts only after the coordination note above is cleared.
- Files: `src/components/content-factory/orchestrator-canvas.tsx` (grid uses `var(--color-border)` today, a raw variable; move to `--border-hairline`); `orchestrator-canvas-parts.tsx` (node card without `shadow-sm` and `rounded-xl`; ports; state pill); `orchestrator-presentation.ts` (kind colours removed; state map rewritten to section h); `orchestrator-composer.tsx` (layout from section i); `orchestrator-screen.tsx` (raw `rounded border border-border bg-surface` selects move to the shared components); `orchestrator-plans.tsx`, `orchestrator-model-panel.tsx`; `run-board.tsx` and `run-panel.tsx` (node dots use the state language); `screen.tsx` and `status.ts` (status labels); `styles.css` (`.orch-node` pops by scale, which section e removes; `.orch-edge` draw stays; `.cf-flow` becomes the red running dash).
- Change: step cards, edges, the composer and the canvas toolbar, plus the new minimap.
- What breaks: `src/components/content-factory/orchestrator-presentation.test.ts` asserts the `ACCENT` keys, that `STALE_STYLE.accent` is "warning", and that `edgeAccent` matches `KIND_STYLE`. It must be rewritten for the new state map. The orchestrator's coloured kinds disappear, which the owner should see before merge (open question 11).
- Test: `npm test` for the presentation module; the orchestrator recorded example at `/orchestrator` in both themes and at 390 px; keyboard walk through the canvas; reduced-motion pass (the running dash must be static).

**M5. Remaining screens.** Brands, studio, factory, library, reviews, settings, learning, market, opportunities and the ops screens.
- Files: the rest of the production files in the counts table (most use `rounded-*`, `surface-2`, `border-border` and `text-fg-muted`).
- Change: mechanical token renames and radius changes, folder by folder, one PR per folder group.
- What breaks: charts. `src/components/studio/learning-bars.tsx` colours positive lift with `var(--color-accent)`. Under Katana that would be red, which is the "now" colour. Positive values become fg-primary and negative values stay danger. The recharts tooltips in `learning/chart-plots.tsx`, `market/intelligence-patterns.tsx` and `brand-overview/review-charts.tsx` use `var(--color-surface)` and `var(--color-border)` and need the new names. `studio/queue-panel.tsx` and `studio/variant-card.tsx` use `animate-spin` and `animate-pulse`, which section e reduces.
- Test: `ui:design-smoke`, `ui:baseline` (it writes to `docs/ui-baseline`, which is not in the repo yet, so the first run creates the baseline), axe via `scripts/a11y-audit.mjs`.

**M6. Cleanup.**
- Files: `src/styles.css` (remove legacy names, shadow tokens, `font-wordmark`, `brass`, `-soft` tokens, the `@fontsource-variable` imports); `package.json` (remove `@fontsource-variable/inter` and `@fontsource-variable/fraunces`; lead approval, since the dependency list changes); the eight files that use `var(--color-*)` in TSX (`settings/auth-shell.tsx`, `home/brand-grid.tsx`, `brand-overview/review-charts.tsx`, `setup/engine-choice.tsx`, `learning/chart-plots.tsx`, `studio/learning-bars.tsx`, `market/intelligence-patterns.tsx`, `content-factory/orchestrator-canvas.tsx`).
- What breaks: anything still on a legacy name renders with no colour. A grep finds them.
- Test: `npm run build`; a grep for `--color-`, `shadow-`, `-soft`, `font-wordmark` returns nothing in `src/`; `npm test && npm run typecheck && npm run lint`.

**Tests that will change.**
- `src/components/ui/tokens.test.ts` and `src/styles.contrast.test.ts`: M1 and M2. They should read `docs/design/tokens/katana-tokens.json` and check its pairs, so the test and the design cannot drift.
- `src/components/content-factory/orchestrator-presentation.test.ts`: M4.
- A new test: no `shadow-` class and no `backdrop-blur` in `src/**/*.tsx`. No `rounded-md` on a surface. No legacy token name.

## n. Open questions for the owner

1. **Default theme.** Dark for everyone (proposed), or follow the operating system as the app does today?
2. **Light theme at launch.** Ship light at launch with the two reds and the ink primary button? Or dark only for now?
3. **Red as "now".** Approve the seven uses in principle 1. Is any other use wanted?
4. **Danger hue.** The danger rose is 7 degrees from the accent red. Keep it (proposed, with an icon and a word always), or choose a more distant hue such as orange-red?
5. **Mark and name.** Approve the wordmark "Meridian" in Archivo 600, sentence case, and the globe mark as drawn.
6. **Motion pace.** Approve a 6 s meridian turn, with the comet running twice round per loop and a 1.1 s trail, or tune them.
7. **Constant motion.** The arc's head never stops, even in the holds. Approve, or should it stop during the holds?
8. **Corner radius.** 2 px (proposed) or 0 px?
9. **Fonts.** Replace Inter and Fraunces with Archivo, Instrument Sans and JetBrains Mono, all OFL? Approve self-hosting woff2 files in `public/fonts`, which adds no npm package.
10. **Not connected in amber.** The engine says "NOT CONNECTED" in capitals. Amber (proposed, because it asks for action), or a neutral grey?
11. **Step kinds without colour.** Remove the ten kind colours and rely on icon and label (proposed)? This changes the orchestrator's look.
12. **Running motion.** A red dash moves on the incoming edge of a running step (proposed). Is that the only moving UI element?
13. **Social card and favicon assets.** Replace `public/og.jpg` with a Katana card? Nothing in the app's head tags references it, so first confirm where it is used.
14. **Benchmarks.** Confirm the six references. Should someone review the live products before launch? This plan did not.
15. **Copy.** Approve "est." as the estimate marker and "not recorded" for missing figures.

## Checks behind this plan

- Contrast: all thirty pairs computed by the repo's helper and by an independent formula, in both themes; they agree to two decimal places. Extra figures (red on white, hue distance) computed the same way.
- Fonts: the three families were checked on the Google Fonts CSS API with the axis ranges used here. Each has an OFL licence text in the google/fonts repository. Instrument Sans's `tnum` feature was read from its GSUB table.
- Logo: the prototype was loaded in headless Chromium with the Playwright path from the brief. Four frames were captured. After the timing change, the logo was rebuilt in WebGL (a glossy globe, a lit 3D blade and bloom); the loop closure and continuity were re-checked over 3600 steps. Reduced motion, the light variant and the Pause button were checked before the change and not after it.
- Favicon: 16 px and 32 px drawings rendered in Chromium at 1x and 2x, on black and on white.
- Code facts: the migration counts and file names come from `src/`, read while the orchestrator files still had uncommitted edits (committed at `d3a5e57` since). A few counts in those folders may shift after the lead's review.
- Not checked: the app was not run or screenshotted, so no screen was seen in Katana; no test was run, because no code changed; the benchmark products were not reviewed live; screen readers and phone hardware were not tested; the sonner colour variable names were not confirmed against the installed version.
