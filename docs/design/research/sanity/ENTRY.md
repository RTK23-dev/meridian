# Sanity.io: deep reference entry

**Reference:** https://www.sanity.io/ (homepage, plus the three mega-menus, the agent panel, the mobile menu and the keyboard path)
**Inspected:** 2 November 2026. Headless Chromium 1280 and 1440 px, phone emulation 390 px with touch, and a 375 to 1440 px width probe.
**Method:** the Swiss futura evidence contract (observed, source, interpretation, adaptation, limit). The evidence is in `sources.json`, `states.json`, `interaction-log.json`, `excerpts.json` and the `states/` captures.
**Main design thesis:** Sanity presents a developer platform as a sequence of its own working surfaces. Type is the hierarchy, mono is the voice of everything operational, and one warm colour marks action. The page proves its claims with the product's real states, not with abstract texture.

## 0. Corrections to the earlier bible

The earlier design bible (`SANITY_DESIGN_BIBLE.md`) was built from computed styles and one viewport. This study found four errors in it. They are corrected here and in the bible's successor.

1. **The page is not dark-first.** The theme is set by the operating system. Under a light OS preference the root reads `data-theme="light"` and the header text is black. Under a dark OS preference the root reads `data-theme="dark"` (verified in `T03-dark-os-top.png`). Dark areas are section backgrounds (the hero, the feature modules and the footer), so dark and light are both used on one page.
2. **The orange CTA is `data-mode="brand"`, not `primary`.** The brand button's base is `background-color: var(--color-brand)` with black text, and its hover inverts to the inverse-base fill with orange text (verified below as G2 and G3). `data-mode="primary"` exists as a separate, different variant (G4).
3. **The button's trim rule is `text-box: trim-both cap alphabetic`.** The bible omitted `trim-both`.
4. **The brand token has three definitions.** `#f50` is defined first in `:root`, `#ff560a` later, and `color(display-p3 1 .3333 0)` inside `@supports (color: color(display-p3 0 0 0))`. The wide-gamut value applies where supported. This is progressive colour enhancement, not a second brand.

## 1. Study boundary and evidence

- **Included.** The homepage, the PRODUCTS, SOLUTIONS and RESOURCES menus, the Ask agent panel and its tabs, the mobile hamburger menu, the keyboard path, the theme shortcut, the reload behaviour, reduced motion, the loading state, the width probe and the hero video.
- **Excluded.** Inner pages, the documentation, the studio and the blog. Third-party consent and analytics scripts, which are the site's, not its design. Moving product media beyond the hero video's metadata and a contact sheet.
- **Capture conditions.** Headless Chromium. Consent banner present in several captures (a Reject click did not match its label). Scroll position and the element that owns scrolling are recorded in each state. The OS colour preference is recorded for each theme capture.
- **Sample of states.** 30 recorded states plus the keyboard path, the menu contents, the reduced-motion and loading probes, and the 9-width probe. The state IDs are in `states.json`.

## 2. The experience as a sequence

Measured section order, top to bottom. Each row records what the section establishes and the claim it asks the reader to accept. Rows 1, 5 and 8 were inspected directly. Rows 2 to 4, 6 and 7 are read from the full-page overview capture, and their proof descriptions are not verified in detail.

| # | Section (heading) | Establishes | Proof offered |
|---|---|---|---|
| 1 | Hero: "The Content Operations Platform" | The category, then the promise: "Power content applications and AI workflows at scale." | A looping 24.8 s video of the product's own states |
| 2 | "Mirror how your content operations team works" | Their editor and the team's working model are the same | A page-editor mock, with its own labels |
| 3 | "Content Operations without the busywork" | Automation removes manual work | An operations mock |
| 4 | "Power anything. One API, every platform" | One platform reaches every surface | An API and platform diagram |
| 5 | "Everything your team needs in one place" | Five capabilities: database, workflows, agent, automation, web/mobile/agent | Five stacked feature modules, each 733 px high |
| 6 | "Loved by 1M+ users and 6k+ teams" | Scale, through named customers | Logo band, stats |
| 7 | "Enterprise-grade everything" | Compliance is a given | Compliance statements |
| 8 | "Less talk, more code" | Developers are the buyer | Three cards: CLI install, MCP server, agent toolkit; two CTAs |
| 9 | Footer | Community, newsletter, legal | Link columns and the wordmark |

**Interpretation.** The narrative is claim, then proof, then the developer's own action. The page never asks the reader to trust a sentence it has not first shown as a product state. Section 8 closes on code, which matches the audience.

## 3. Information architecture (the mega-menus)

Measured with `menus.json`. Each menu is a three-column taxonomy with its own promotion.

- **PRODUCTS.** Two groups, CONTENT OPERATIONS (Studio, Content Agent NEW, App SDK, Media Library, Content Releases, Agent API) and CONTENT BACKEND (Content Lake, Sanity Context NEW, MCP Server NEW, Functions, Live CDN). A promotion card reads SEE WHAT WE ANNOUNCED.
- **SOLUTIONS.** Seven audiences or industries (E-commerce & Retail, Media & Publishing, SaaS, Developers, Content Editors, Product Owners, Business Leaders), plus READ THE STORY.
- **RESOURCES.** Learning (Sanity 101 NEW, Sanity Learn, Pioneers, Frameworks, Templates, Tools and plugins, Schemas and snippets), community and content (Join our community, Blog, Engineering, Events & Webinars with a count badge of 3, Customer stories, Guides, Use Cases), and a promotion for the swag store.

**Interpretation.** Labels use one vocabulary (NEW as a text badge, a count as a small badge). The promotion card is a single image plus a mono caption, so every menu ends in a concrete next step.

## 4. Structure and the global header

Measured (`report.json`, `states.json`):

- Announcement bar 36 px, above the header at scroll 0 (`D01`: header at y = 36).
- Header 67 px high, `padding: 0 24px`, transparent over the hero on desktop.
- **Scroll threshold.** At 60 px of scroll (`D06`) the header is `data-scrolled="false"`. At about 960 px (`D07`) it is `data-scrolled="true"`. The script (`Navbar`, verified below) sets the attribute when `scrollY > 60` and the viewport is 768 px or wider.
- **Announcement offset.** The script writes `--announcement-banner-offset = min(scrollY, bannerHeight)` on scroll, so the header rises flush as the banner scrolls away.
- **Agent panel pushes the page.** When Ask agent opens, `data-chat-pushed` is set on the root, the header width falls from 1440 to 1008 px, and the H1 falls from 112 to 96 px (`D05`). The page reflows; the panel does not overlay it.

## 5. The state map

| From | Trigger | To | Retained context | Evidence |
|---|---|---|---|---|
| Default | Click PRODUCTS | Products mega-menu | Hero visible below | D02 |
| PRODUCTS | Escape | Default | Focus on the button | D02b |
| Default | Click SOLUTIONS / RESOURCES | Respective menu | Header remains | D03, D04 |
| Default | Click Ask agent | Agent panel, page pushed | Tabs: Ask agent, History, Links | D05, A-history, A-links |
| Top | Scroll 60 px | Header settles to the top edge | None | D06 |
| Top | Scroll ~960 px | Header gains its surface | None | D07 |
| Light theme | Shift+L | Dark theme | Stored in `localStorage["theme"]` | T01, T01-storage |
| Dark stored | Reload | Dark still set | Persisted | T02 |
| Desktop | Resize below 768 px | Header and H1 step down | Layout only | W767, W768 |
| Phone | Tap Open menu (aria-label) | Mobile menu | Page behind | M02b |
| Mobile menu | Tap PRODUCTS | Submenu expanded | Menu open | M03b |

**Interpretation.** Each state changes one or two coupled things: the menu, the header surface, the page width, or the theme attribute. The coupling is the design. The agent panel is the clearest case, because opening it changes the H1 size as well as the panel.

## 6. Element inventory

| ID | Element | Job | Implementation (verified where marked) | State |
|---|---|---|---|---|
| E01 | Announcement bar | Current news, one mono line, one arrow | `#announcement-banner`; offset var (G12) | Scroll-linked |
| E02 | Header | Global navigation, surface change | `#sanity-header`; `data-scrolled`, `data-transparent` (Navbar) | Transparent, then surface |
| E03 | Wordmark | Identity | SVG | Static |
| E04 | Nav links | Destinations | Mono uppercase, 13 px | Hover: colour change (0.15 s) |
| E05 | Mega-menu buttons | Open taxonomy | No `aria-expanded` (verified in `aria.json`) | Open or closed |
| E06 | Brand CTA | The main action | `data-mode="brand"` (G2, G3) | Hover inverts |
| E07 | Outline CTA | The alternative | Outline mode | Hover |
| E08 | Install pill | Copy a command | `npm create sanity@latest` plus copy icon | Copy |
| E09 | Hero video | Show the product | `<video>`, VP9, 24.76 s, `lazyVideo` | Loops, muted |
| E10 | Logo band | Social proof | Full-width brand fill, 82.75 s marquee | Animates |
| E11 | Section h2 | Claim | 72 px, 64 px bottom margin | Static |
| E12 | Feature modules | Five capabilities | 733 px modules | Static, scroll |
| E13 | Agent panel | Ask a question about the product | `role="tablist"`, `aria-selected` (verified) | Open or closed, pushes page |
| E14 | Cookie banner | Consent | Third party (Osano) | Dismissed or not |
| E15 | Footer | Community, newsletter, links | `footer`, `#0b0b0b` | Static |

## 7. Typography

**Faces, served and loaded.** Waldenburg (sans) at 400 normal and 600, plus 400 italic (`@font-face`, `font-display: swap`). IBM Plex Mono at 400, with 700 declared. Measured `document.fonts`: Waldenburg 400 loaded at 300 ms, IBM Plex Mono 400 loaded.

**Measured scale** (from `report.json` and the width probe):

| Role | Size | Line height | Tracking | Weight | Face |
|---|---|---|---|---|---|
| H1 at 1440 | 112 px | 112 px | −4.48 px (−0.04 em) | 400 | Sans |
| H1 at 1024 | 112 px | 112 px | (same) | 400 | Sans |
| H1 at 768 to 800 | 96 px | | | 400 | Sans |
| H1 at 600 to 767 | 72 px | | | 400 | Sans |
| H1 at 375 to 390 | 60 px | | | 400 | Sans |
| H2 section | 72 px | 72 px | −2.88 px | 400 | Sans |
| Lead | 32 px | 35.2 px | −0.32 px | 425 | Sans |
| Body | 16 px | 24 px | normal | 400 | Sans |
| Control, nav | 13 px | 16.9 px | normal, uppercase | 400 | Mono |
| Label, code | 12 px | 18 px | normal | 400 | Mono |

**Interpretation.** The H1 is a tiered type scale, not a fluid one. Measured steps occur at 768 px and below 768 px, and between 800 and 1024 px for the largest step. I did not find the exact breakpoint between 800 and 1024; the study records that as a limit. The scale is a set of tiers chosen per container, which is also why the agent panel shrinks the H1 (section 4).

**Code evidence** (verified, `G1`):

```css
/* global.BIrt0173.css @24439, verified byte-for-byte against the raw asset */
._button_sfoeg_3{font-family:var(--font-mono);letter-spacing:0;text-box:trim-both cap alphabetic;text-transfor…
```

`text-box: trim-both cap alphabetic` trims the leading above the cap height and below the baseline, so a mono control is optically centred. This is the detail the bible missed.

## 8. Grid, proportion and spacing

Stylesheet tokens (verified G11, G10): `--gutter: 4px`, `--max-width: 1920px`, `--margin-x-min: 24px`, `--section-padding-x: 1.5rem`, `--spacing-widget-md: calc((35 / 16) * 1rem)` (35 px). The twelve columns are solved from the content width (`--columns-1 = (content − 11 × gutter) / 12`).

Measured anchors: section h2 `margin-bottom: 64px`; the header is 67 px; the feature modules repeat at 733 px; the footer padding is 24 px. The control `md` height is 35 px, and the measured hero button is 35 px.

**Interpretation.** The gutter is 4 px, so the columns read as one field and the grid is felt through text edges, not through visible boxes. The header and the section edges share the 24 px margin, so every text edge lines up with the page margin.

**Oddity.** `--spacing-24` is `1.51rem`, not `1.5rem`. Nothing visible depends on it, but a scale should be exact.

## 9. Colour and surfaces

**Primitives.** Black `#0b0b0b` (not `#000`), white `#fff`, brand `#ff560a`, a gray scale (`#ededed` to `#212121`), and four accent families (blue, green, magenta, yellow), each with 100, 300, 500 and 700 steps (stylesheet, root).

**Semantic roles** flip under `data-theme`: `--color-bg-base` (black or white), `--color-bg-dim`, `--color-bg-inverse-base`, `--color-fg-base`, `--color-border-base`, `--color-border-dim`.

**Brand token** (verified G6 and the `@supports` block): sRGB `#f50` first, then `#ff560a`, then `color(display-p3 1 .3333 0)` inside `@supports (color: color(display-p3 0 0 0))`.

**Button modes** (verified, the `_button_sfoeg_3[data-mode=…]` selectors): `accent`, `brand`, `ghost`, `muted`, `outline`, `primary`. The primary orange CTA is `brand`.

**Brand button, verified** (`G2`, `G3`), raw text:

```css
._button_sfoeg_3[data-mode=brand],._button_sfoeg_3[data-mode=brand]:active{background-color:var(--color-brand);border-color:var(--color-brand);color:var(--color-black)}
._button_sfoeg_3[data-mode=brand]:hover{background-color:var(--color-bg-inverse-base);border-color:var(--color-bg-inverse-base);color:var(--color-brand)}
```

**Observed.** Hover on the brand CTA turned its fill black and its text orange (`interact.json`). In light theme the inverse-base is black.

**Surfaces.** Measured shadows: one element on the whole page has a `box-shadow`. Borders are 1 px hairlines in `#353535` (dark) and `#d6d6d6` (light). The page's large field of colour is the logo band, a brand fill, which breaks the dark rhythm at its proof point.

## 10. Media and motion in the hero

**The hero video, verified.** `cdn.sanity.io/files/3do82whm/next/bdd4…webm`: VP9, 1200 × 900 (4:3), 29.97 fps, 24.758 s, 17,393,536 bytes, SHA-256 `2f36780…`. The page displays it at 1440 × 892 (16:10), so `object-fit: cover` crops the 4:3 master. The `video` element carries `lazyVideo` and `loaded` attributes and eight `source` variants, which means a responsive set is served.

**Frames, observed.** A contact sheet of 12 frames (`frames/hero-contact-sheet.png`) shows, in order: a dot-matrix field, a stacked-layers content-model diagram, an AI assistant on a photograph, a content list with count badges (2 updates, 1 updates, 3 updates), a schema editor, a pixel-mosaic transition, and a grid of web-page thumbnails. The reel is the product's own working surfaces.

**Interpretation.** The hero demonstrates rather than decorates. The pixel-mosaic transition recurs as a motif and is the one ambient flourish.

**Motion inventory** (`report.json`, verified keyframe names): `marquee-scroll` (82.75 s, the logo band), `homepage-customers-countdown` (9.7 s), `delay-overflow` (0.4 s), `_reveal_pxga6_1` (scroll reveal), plus product-mock keyframes (`text-shimmer`, `caret-blink`, `live-recording-blink`, `pulse`, `spin`, `progress-step`).

**Easing, verified** (`G8` region and the frequency count): `cubic-bezier(.4, 0, .2, 1)` on 72 transitions; `cubic-bezier(0, 0, .2, 1)` and `cubic-bezier(.4, 0, .6, 1)` on fewer.

## 11. Reduced motion: an observed gap

The stylesheet has one reduced-motion block (verified, `G8`):

```css
@media (prefers-reduced-motion:reduce){.motion-reduce\:hidden{display:none}.motion-reduce\:translate-y-0{…}}
```

The rule is per component, through utility classes. There is no global rule. With reduced motion emulated (`R01`), three elements still animate: `marquee-scroll` (82.75 s), `homepage-customers-countdown` (9.7 s) and `delay-overflow` (0.4 s).

**Consequence.** The logo band keeps moving for a user who asked it not to.

## 12. Responsive behaviour

Width probe (`states.json`, `W*`), desktop viewport at each width:

| Width | Header y | H1 | Header controls (approx.) |
|---|---|---|---|
| 1440 | 36 | 112 px | 13 |
| 1280 | 36 | 112 px | 13 |
| 1024 | 36 | 112 px | 12 |
| 800 | 36 | 96 px | 8 |
| 768 | 36 | 96 px | 8 |
| 767 | 36 | 72 px | 8 |
| 600 | 36 | 72 px | 5 |
| 390 | 41 | 60 px | 5 |
| 375 | 41 | 60 px | 5 |

**Interpretation.** The header keeps its 67 px height at every width. The control count falls as the menus collapse. The H1 steps down at 768 px and again at 600 px, and reaches 60 px at 390. The thresholds between the probe widths were not isolated. At 390 the announcement bar wraps to two lines, which moves the header from y = 36 to y = 41.

**Phone composition** (`M01`, `M02b`, `M03b`). The hero stacks: the wordmark and the orange CTA sit in the header, the H1 is 60 px, the lead follows, the install line is below. The hamburger opens a menu with the same taxonomy as the desktop menus (Home, Products, Solutions and so on, verified in `menus.json`). The phone layout is a recomposition of the same content, not a shrunken copy of the desktop.

**Limit.** The mobile menu's internal interaction was only checked for the PRODUCTS expansion, not every item.

## 13. Keyboard, focus and accessibility

**Focus path, first 12 stops** (`K01-focus-path`, verified):

1. PREFERENCES (consent banner)
2. Close this consent banner (consent banner)
3. Announcement link, focus offset **−2px** (inset; every other stop is +2px)
4. SKIP TO CONTENT
5. Home
6. PRODUCTS
7. SOLUTIONS
8. RESOURCES
9. DOCS
10. ENTERPRISE
11. PRICING
12. LOG IN

**Focus ring, verified** (`G5`):

```css
:focus-visible{outline:var(--focus-ring-width) var(--focus-ring-style) var(--color-focus-ring);outline-offset:…}
```

With the tokens, the ring is 2 px, dotted, offset 2 px. The PRODUCTS button shows exactly that (`aria.json`).

**Findings.**

- **The skip link is fourth.** The consent banner's two buttons come first in this capture, then the announcement link, then the skip link. A skip link is most useful as the first stop.
- **The mega-menu buttons do not expose their state.** PRODUCTS, SOLUTIONS and RESOURCES have no `aria-expanded` and no `aria-haspopup` (`aria.json`).
- **The agent panel uses the tab pattern correctly.** `role="tablist"`, `aria-selected` on Ask agent, History and Links.
- **The theme shortcut is hidden.** Shift+L toggles the theme and is stored in `localStorage["theme"]`. It is not documented on the page in this capture.
- **Reduced motion is partial** (section 11).

## 14. Loading and time

**Fonts.** At 300 ms after DOMContentLoaded, Waldenburg 400 is `loaded` and the other Waldenburg weights are `unloaded` until used. The page relies on `font-display: swap`.

**Layout stability.** Cumulative layout shift measured across the load: **0** (`L01`). The hero's reserved geometry holds.

**Deferred work.** The shared `defer-task` module (`defer-task.BHN7Bw-1.js`, verified) schedules non-critical tasks with `scheduler.postTask`, or `requestIdleCallback`, or `setTimeout`. The navigation script calls it for its initial header state.

**Theme before paint.** The theme module (`_theme.p7GfTtg2.js`, verified) reads `localStorage["theme"]`. When its environment check fails, it returns the default `{setting: 'system', theme: 'light'}`. The root `data-theme` is set on load and follows the `prefers-color-scheme` media query while the setting is `system`.

## 15. Source-verified excerpts

Every excerpt below was checked against the raw saved file (`excerpts.json`). The offsets are bytes in the raw asset. The asset was downloaded with its build parameter, and its SHA-256 is in `sources.json`.

**Header scroll logic** (`Navbar.astro_astro_type_script_index_0_lang.nyrw1ZEO.js`, SHA-256 `10e45789…`, whole file, minified; whitespace reformatted):

```js
const header = document.getElementById('sanity-header');
const transparent = header.dataset.transparent === 'true';
const update = () => {
  const threshold = transparent && window.innerWidth >= 768 ? 60 : 0;
  const y = document.documentElement.hasAttribute('data-chat-pushed')
    ? document.getElementById('agent-page-viewport')?.scrollTop ?? 0
    : window.scrollY;
  header.dataset.scrolled = (y > threshold).toString();
};
defer(() => update());
document.addEventListener('scroll', () => update(), { capture: true, passive: true });
```

*Adaptation note:* the minified source is `e=n&&window.innerWidth>=768?60:0,i=…`. I expanded the names. The logic is unchanged.

**Announcement offset** (same file):

```js
const banner = document.getElementById('announcement-banner');
const setOffset = () => {
  if (document.documentElement.hasAttribute('data-chat-pushed')) return;
  const t = Math.min(window.scrollY, banner.offsetHeight);
  document.documentElement.style.setProperty('--announcement-banner-offset', `${t}px`);
};
setOffset();
window.addEventListener('scroll', setOffset, { passive: true });
```

**Theme** (`_theme.p7GfTtg2.js`, SHA-256 `4e2db749…`, minified; expanded):

```js
const MEDIA = '(prefers-color-scheme: dark)';
const KEY = 'theme';
const resolve = (setting) => setting === 'dark' ? 'dark' : setting === 'light' ? 'light'
  : matchMedia(MEDIA).matches ? 'dark' : 'light';
// Shift+L toggles between dark and light; the setting is saved to localStorage.
```

## 16. Principles

Each principle is labelled as an established concept or as proposed vocabulary.

| Principle | Status | Definition | Evidence |
|---|---|---|---|
| Tiered type scale | Proposed | The H1 steps by container and viewport tiers, not a fluid curve | Width probe; agent panel |
| Coupled chrome | Proposed | One state change moves several chrome elements (menu, surface, page width, theme) | D05, D07, T01 |
| Progressive colour | Established (CSS `@supports`) | sRGB fallback, wide-gamut where supported | G6, `@supports` block |
| Trim to the cap height | Established (CSS `text-box`) | Mono controls centre on cap height | G1 |
| Scroll-linked header | Proposed | The header's surface and offset follow scroll position | Navbar script |
| Demonstration, not decoration | Proposed | The hero is a reel of working surfaces | Frame contact sheet |
| Named motion budget | Proposed | Motion is limited to a few named elements, but reduced motion is partial | R01 |

## 17. Limits

- Headless Chromium only. Not tested on Safari, Firefox, or a physical phone.
- One homepage. Inner pages, the docs and the studio are not covered.
- Hover, focus and menus were tested on samples, not every control.
- The consent banner was present in several captures. Its interaction was not isolated.
- The hero video's motion was assessed from a 12-frame contact sheet, not from full playback.
- Screen-reader behaviour was not tested. The ARIA findings are from the DOM.
- The highlighter's identity is inferred from colours, not confirmed by name.
- Exact breakpoints between 800 and 1024 px were not isolated.
- Third-party scripts (analytics, consent) were not analysed.

## 18. Evidence index

| File | Contents |
|---|---|
| `sources.json` | 16 hashed sources, with URL, bytes, status and SHA-256 |
| `states.json` | 30 states and probes: menus, header, scroll, theme, reload, reduced motion, loading, mobile, width |
| `interaction-log.json` | Actions performed and their results |
| `menus.json` | Menu contents, dark-OS theme, mobile menu links |
| `aria.json` | Menu ARIA state, agent tabs, focus on the PRODUCTS button |
| `excerpts.json` | Raw CSS excerpts with byte offsets and verification |
| `inventory.json` | Interactive, landmark and media inventory |
| `tabs-videos.json` | Agent tabs and video elements |
| `raw/` | Retrieved assets, including the homepage and the hero video |
| `frames/hero-contact-sheet.png` | 12 frames across the hero video |
| `states/*.png` | Captures for each state |
