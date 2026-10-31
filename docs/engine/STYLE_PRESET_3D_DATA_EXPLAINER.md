# Style preset run: the 3D satellite data explainer (2026-10-31)

The owner uploaded one reference video and asked: use Meridian's system to copy its style, and make a full preset that can be reused
any time for 3D explainer videos like it. This is the record of that run. The preset is `src/engine/presets/three-d-data-explainer.ts`.

## 1. The reference

| Field | Value |
| --- | --- |
| Length, size, frame rate | 60.0 s, 720x1280 (9:16), 30 fps, H.264 and AAC |
| SHA-256 | `98053a5a224b3833a3ed4421818f8c6f6d623cac99e6c017585ccc6bb1706377` |
| Format id (Content Factory rule) | `ref_98053a5a224b3833a3ed4421` |
| Topic | How hedge funds read satellite images (parking lots, oil tanks, coffee farms) before official numbers come out |

The file was not committed. Only measures and observations are stored (genes, not content).

## 2. What ran, and what did not

| Step of analyze_reference (Bible 6.2) | Ran? | How |
| --- | --- | --- |
| Probe, scene cuts, loudness, timeline, picture (zoom and loop), black, flicker, motion, silence | Yes | Meridian's own handlers in `functions/ffmpeg/`, on the local file. No network, no spend |
| Zoom jumps, loop verdict, loudness per tenth, edit grammar | Yes | The engine's pure code: `analyze/zoom.ts`, `analyze/measure.ts`, `edit/grammar.ts` |
| Speech-to-text | No | A paid provider call. Agents hold no live keys |
| Segmenter, genome, frame_reader roles | No | Paid Claude calls through the gateway |

The engine's grammar refused to build an edit grammar from the free measures alone, as it should (fail closed). Its answer:

- motion: no shake or speed-ramp reading is connected, so the motion fields are unknown
- captions: no caption reading is connected
- sound: no speech spans, so music, tempo, energy and sound effects cannot be separated from the voice

So the preset carries the measured parts, the parts read from frames by the coding agent (labelled `read`, not engine output), and a
list of what stays unknown until one live analysis runs.

## 3. What was measured

| Measure | Value | What it means for the style |
| --- | --- | --- |
| Hard scene cuts (score 0.3) | 9 in 60 s; the first at 6.8 s | Few hard cuts |
| Shot length p25, p50, p75 | 3.2 s, 4.1 s, 6.5 s | Long shots by short-form standards |
| Zoom jumps | 8, of which 7 push in (median scale 1.52) | The camera moves instead of cutting |
| Pattern interrupts (cuts and zoom jumps) | 17; median gap 2.7 s | Something changes about every 2.7 s |
| Mean motion energy | 0.020 (0 to 1) | Calm, smooth camera |
| Loudness | -14.1 LUFS integrated, -1.1 dBTP peak, 2.8 LU range | Platform-level loudness, tightly compressed voice |
| Silences | 0.5 s at 42.9 s; 1.0 s at the end | One dramatic pause before the third case |
| Loop distance | 0.101 (loop test: at most 0.04) | The end returns to the opening scene, but not frame for frame |

## 4. What was read from the frames

- **Look**: photoreal 3D satellite and aerial scenes in muted natural colours, objects outlined in teal, a dark navy 3D "data room"
  with ceiling light strips for the proof, and a few glossy 3D props (a phone, a balance, a stack of notes).
- **Hook title**: two lines at the top; a bold white claim whose last words turn to a gold italic serif; a live counter with a small
  dark pill label under it.
- **Captions**: 1 to 3 words, white bold sans, centred low (about 73% of the height); the spoken word in a filled yellow box with dark
  text; the words still to come dimmed.
- **Palette (sampled)**: teal `#307080`, light cyan `#A8D8D8`, gold `#F0C048`, white `#F8F8F8`, navy-black `#000010`, caption yellow
  `#F0E860`, down red about `#C04858`. Up green and the follow-button blue were seen, not sampled.
- **Structure**: hook (claim and live count) → the method in one camera move → three cases, each with a place, a number and a price
  move → the idea that joins them → back to the opening scene with a follow button.

## 5. How to reuse the preset

1. Install the style kit into the workspace: `installStylePreset(sql, { organizationId, presetId: "3d_data_explainer" })`. It writes
   kit `sk_3d_data_explainer` version 1 into `engine_kits`. No screen calls it yet.
2. On the brand's theme page, set the style kit to `sk_3d_data_explainer`.
3. In the Content Factory, attach the same reference file and mark it as the reference. Its format id is `ref_98053a5a224b3833a3ed4421`.
   The first run analyses it (paid); every later run reuses the stored Video DNA.
4. Keep the genes in `genes.keep`; write a new subject, new cases and a new script.

## 6. What the preset cannot do yet

| Gap | Needs |
| --- | --- |
| The gold italic accent font of the hook | An accent font role in the style kit (contract change, Q1) |
| More than five colours (up green, down red, pill grey, button blue) | More palette roles (contract change, Q1), or keep five |
| The filled yellow box behind the spoken word, and dimmed words to come | A caption component: `captions.boxed` is in the contract but has no component |
| Counters with pill labels, place and date pills, bar and line chart panels | New `coded_graphics` components |
| The 3D aerial flights and props | Generated shots (`video.cinematic`): the owner's spend approval |
| The full Video DNA | One live analysis of the reference, then cached |
| A screen to install a preset | A button on the theme page, once the owner confirms presets as a product feature |

These are recorded as Q30 in `.claude/loop/OPEN_QUESTIONS.md`.

## 7. Test: an original video made from the preset (2026-10-31)

The owner asked for a video made from scratch with the preset, to see how close it gets and what the preset lacks. Meridian's rule is to
copy genes, never content, so the test video has its own subject and script ("scientists count animals from space": penguin colonies
found by their stains on the sea ice, elephants counted in satellite photos, whales seen at about 30 cm per pixel). It keeps the
preset's beat structure, cut times, zoom jumps, palette, fonts, caption style and loudness.

How it was made: `scripts/engine/preset-preview/` draws the 3D scenes as WebGL shaders (sea ice, savanna, ocean, a globe, a dark data
room and a satellite prop) with HTML overlays (title, counters, pills, panels, captions), in the local Chromium, frame by frame. The
preset is injected into the page, so the colours, caption look, cut times and zoom jumps come from it. No provider was called and
nothing was spent. There is no voice-over: speech is a paid provider call, so the captions carry the script and the sound is a
synthesised bed at the preset's loudness. The output is in `artifacts/preset-preview/` (not in git).

### First render, measured against the reference

`compare.ts` runs the same media handlers on both files:

| Measure | Reference | Render 1 | Read |
| --- | --- | --- | --- |
| First cut | 6.77 s | 6.80 s | Matched |
| Hard cuts | 9 | 5 | 4 planned cuts did not register: both sides looked alike |
| Shot length p25, p50, p75 | 3.2, 4.1, 6.5 s | 4.3, 8.2, 10.6 s | Follows from the missing cuts |
| Zoom jumps | 8 | 8 | Matched |
| Punch-ins per 10 s, median scale | 1.17, 1.52 | 0.83, 1.32 | Close; two jumps were drawn as camera moves |
| Pattern interrupt median | 2.7 s | 2.6 s | Matched |
| Mean motion | 0.020 | 0.005 | 4 times too calm |
| Mean brightness | 0.39 | 0.43 | Close |
| Loudness | -14.1 LUFS, 2.8 LU range | -14.1 LUFS, 0.4 LU range | Level matched; no voice, so no dynamics |
| Loop distance | 0.101 (no loop) | 0.053 (no loop) | Same verdict |

Motion per tenth (timeline motion): reference 0.12, 0.08, 0.09, 0.08, 0.11, 0.10, 0.08, 0.06, 0.06, 0.10; render 1: 0.06, 0.09, 0.08,
0.02, 0.04, 0.04, 0.02, 0.03, 0.02, 0.09. The hook and the ending were close; the data room, the savanna and the ocean moved far too little.

### What the preset lacked, and what changed (preset version 2)

| Gap found by the render | Change |
| --- | --- |
| Overlay positions and sizes (title, counter, pills, captions, follow button) had to be chosen by hand | A `layout` block, as fractions of the frame, read from the reference; the renderer now reads it |
| Zoom jumps carried no context: a 1.64 punch at 4.4 s stacked on the pull-up to orbit and blew the globe up | `layout.zoomJumpKinds`: each jump is a `punch` or part of a `camera_move` |
| One motion number for the whole video, so the camera speed per section was a guess | `grammar.measured.motionTenths`, the reference's motion per tenth |
| Cut times without the rule that makes a cut register | `grammar.read.cutRule`: a cut must change place, scale or set; same-scene cuts do not count |
| The accent font role is missing (the serif accent rendered small) | Still a contract gap (Q1, Q30 part B); the renderer scales the accent words up |
| Up-green and the follow-button blue were not sampled | Still open; the render used a chosen blue |
| No counter, pill, chart or boxed-caption components in the compose library | Still open (Q30 part C); the preview draws them in its own page |

### Second render

The renderer was re-tuned with the version 2 fields: faster camera moves in the data room, savanna and ocean, and cuts that change scale
or set. Its measures are in section 8.
