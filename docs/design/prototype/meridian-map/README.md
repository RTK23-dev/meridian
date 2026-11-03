# Meridian site background

A site-wide background that is the world as a two-colour depth map. Each screen is one stop down the line of longitude, and the map under the page moves with the scroll. Yellow bills on the screens are printed by dither as they move through the middle of the window.

This is a prototype in the design folder. It changes nothing under `src/`.

## Files

- `world-lines.mjs`: the depth map, one bit per half-degree cell. It is generated: do not edit it by hand.
- `build-map.mjs`: builds `world-lines.mjs` from the public-domain land outline. Its input is `world-atlas@2.0.2/land-110m.json` (Natural Earth), fetched from `https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json`.
- `map-model.mjs`: the rules with no DOM: the route, the latitude at a scroll position, the map cell each screen cell shows, the bit lookup, the bill's dither and its print amount.
- `site.mjs`: draws the map, the bills, the grain, the loop and the route. `site.css` and `index.html` are the page.
- `build-site.mjs`: writes the single-file page for publishing.
- `capture-site.mjs`: checks the page in headless Chromium and saves a screenshot of each stop.
- `tuner.html`, `tuner.mjs`, `tuner.css`: the simulator. It runs the same background, with every value open to change in a drawer: colours, spacing, pixel size, zoom, glide, grain, meridian, bill printing and the route. At its defaults it draws the same pixels as the published site. Values are kept on the device, and can be copied out as JSON or as a settings object, and pasted back in.
- `world-field.mjs`: the signed distance from the coast for every cell, one signed byte each. It is generated with `world-lines.mjs`, and lets the simulator change the spacing.
- `build-tuner.mjs`: writes the simulator as one file for publishing.
- `capture-tuner.mjs`: checks the simulator in headless Chromium: parity with the published site, the readout, each value, presets, copy and paste, autoplay, reduced motion, and the phone layout.

## Run it

    node docs/design/prototype/meridian-map/build-map.mjs <land-110m.json> docs/design/prototype/meridian-map/world-lines.mjs 12
    node docs/design/prototype/meridian-map/capture-site.mjs
    node docs/design/prototype/meridian-map/build-site.mjs <output.html>
    NODE_ENV=development node --test scripts/meridian-map.test.mjs

The depth map uses a contour line every 12 cells (6 degrees). The line share is 18.5 per cent of the cells.

## Rules it keeps

- Two colours on the map: the ground and its line. Yellow is used only on the bills, and red only on the meridian line.
- The loop is a half turn of the map. The last screen is the first stop again, so the jump back changes no pixel.
- Reduced motion holds the map still, and the page does not glide.
