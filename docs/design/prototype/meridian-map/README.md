# Meridian site background

A site-wide background: the world drawn as a square halftone. Each screen is one stop down the line of longitude, and the map under the page moves with the scroll. Yellow bills on the screens are printed by dither as they move through the middle of the window.

This is a prototype in the design folder. It changes nothing under `src/`.

## Files

- `world-field.mjs`: the signed distance from the coast for every half-degree cell, one signed byte each. It is generated: do not edit it by hand.
- `world-lines.mjs`: the depth lines at a 12-cell spacing, one bit per cell, built from the same outline. It is generated, and the checks use it to confirm the distance field.
- `build-map.mjs`: builds both generated files from the public-domain land outline. Its input is `world-atlas@2.0.2/land-110m.json` (Natural Earth), fetched from `https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json`.
- `map-model.mjs`: the rules with no DOM: the route, the latitude at a scroll position, the bills' dither and print amount, and decoding the field.
- `halftone.mjs`: the background. It samples the distance field at each block's centre, turns it into tone, and draws square blocks at full resolution. The site and the simulator both draw through it.
- `site.mjs`, `site.css`, `index.html`: the page. `build-site.mjs` writes it as one file for publishing.
- `capture-site.mjs`: checks the page in headless Chromium and saves a screenshot of each stop.
- `tuner.html`, `tuner.mjs`, `tuner.css`: the simulator. It draws through `halftone.mjs`, and every value is open to change in a drawer: colours, grid spacing, block size, band sharpness, opacity variation, contour spacing, zoom, glide, grain, meridian, bill printing and the route. At its defaults it draws the same pixels as the published site. Values are kept on the device, and can be copied out as JSON or as a settings object, and pasted back in.
- `build-tuner.mjs`: writes the simulator as one file.
- `capture-tuner.mjs`: checks the simulator: parity with the published site, the readout, each value, presets, copy and paste, autoplay, reduced motion, and the phone layout.

## How the background is drawn

- The grid has a point every `pitch` screen pixels (6 in the published site). A square is centred on each point.
- The distance at a point is read bilinearly from the field, so the tone changes smoothly between cells. Columns wrap round the world, and rows are held at the poles.
- Tone: `ink = ((1 + cos(2π · distance / step)) / 2) ^ sharp`. The ink is full on each contour, where the distance is a multiple of `step` cells, and none halfway between two contours. The published site uses a step of 12 cells, which is 6 degrees.
- A square's side is `pitch × block × √ink`, so darker bands take larger squares. Squares with almost no ink are not drawn.
- Each square's opacity is `0.8 + 0.2 × ink`, varied by `jitter` from a fixed value for its grid position, so the variation does not change from frame to frame. It is drawn in eight steps.
- The middle of the window is the meridian. A point at screen `(x, y)` shows the longitude `(x − w/2) / zoom` and the latitude `centre − (y − h/2) / zoom`, where `zoom` is pixels per degree (8 in the published site).
- The canvas is sized at the screen's pixel density, so every square is drawn sharp.

## Run it

    node docs/design/prototype/meridian-map/build-map.mjs <land-110m.json> docs/design/prototype/meridian-map/world-lines.mjs 12
    node docs/design/prototype/meridian-map/capture-site.mjs
    node docs/design/prototype/meridian-map/capture-tuner.mjs
    node docs/design/prototype/meridian-map/build-site.mjs <output.html>
    node docs/design/prototype/meridian-map/build-tuner.mjs <output.html>
    NODE_ENV=development node --test scripts/meridian-halftone.test.mjs scripts/meridian-map.test.mjs scripts/meridian-map-simulator.test.mjs

The captures write screenshots to `site-screens` and `tuner-screens`, and their claims to `site-measurements.json` and `tuner-measurements.json`. They exit non-zero if a claim fails.

`sampleIndex` (the cell a screen cell showed in the earlier pixel version) and `linesFromField` are kept in `map-model.mjs` for the checks. The page does not draw with them.

## Rules it keeps

- Two colours and the mix between them: the ground and the block colour, with the blocks at varied opacity. Every pixel of the map lies between the two. Yellow is used only on the bills, and red only on the meridian line.
- The loop is a half turn of the map. The last screen is the first stop again, so the jump back changes no pixel.
- Reduced motion holds the map still, and the page does not glide.
