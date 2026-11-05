# Motion library

Ammunition for authoring motion, not a style to copy. You are the motion designer: decide what the piece is saying, pick a register, then pick curves, timing and devices that carry it. Different pieces should come out different. The rules that point here are in `SKILL.md`.

Code: `motion-kit.js` beside this file (GSAP, seek-safe). Every curve below is available by name: `MotionKit.curve('carbon.expressive.entrance')`, `MotionKit.curve('kit.land')`, or your own `MotionKit.bez(x1, y1, x2, y2)`. Values are `cubic-bezier(x1, y1, x2, y2)`, the same numbers as CSS and as an After Effects or Blender handle pair.

## 1. Pick a register first

| Register | What it should feel like | Curves to start from | Timing |
|---|---|---|---|
| Technical / product | Precise, efficient, confident | `carbon.productive.*`, `m3.standard*`, `kit.whip` for state changes | Short, tight, few devices |
| Explainer / editorial | Clear cause and effect, guided eye | `kit.land`, `kit.heavy`, `kit.reveal`, `m3.emphasized*` | Distance-driven; holds stay alive |
| Premium / cinematic | Weight, long settles, restraint | `easings.outExpo`, `easings.inOutQuint`, `kit.heavy`, springs at damping 1 | Longer; fewer, bigger moves |
| Expressive / launch | Moments meant to be noticed | `carbon.expressive.*`, `kit.whip`, springs at 0.7 to 0.8 | Contrast: snaps against holds |
| Playful / consumer | Elastic, physical, characterful | springs 0.55 to 0.7, `easings.outBack` (sparingly), squash and stretch | Bouncier, quicker reactions |
| Calm / ambient | Breathing, continuous | `easings.inOutSine`, `kit.drift`, linear for constant drift | Long, overlapping, no hard stops |

Mixing is fine: a technical piece can have one expressive moment. One register everywhere reads flat; every register at once reads like a demo reel.

## 2. Curves by source

**Motion-design curves (`kit.*`, authored from After Effects practice: Easy Ease with influence dragged to 70 to 90%).** Each is a character, not a strength.

| Name | Bezier | Character |
|---|---|---|
| `kit.land` | 0.1, 0.75, 0.15, 1 | Arrives at speed, long confident settle. Entrances from off-frame. |
| `kit.heavy` | 0.75, 0, 0.18, 1 | Slow push-off, decisive arrival. Big objects, camera moves. |
| `kit.whip` | 0.85, 0, 0.15, 1 | Hang, snap, hang. State changes, transitions. |
| `kit.reveal` | 0.22, 1, 0.36, 1 | Almost all travel in the first third. Masked type. |
| `kit.leave` | 0.55, 0, 0.9, 0.35 | Accelerates out, never settles. Exits. |
| `kit.wind` | 0.45, 0, 0.55, 1 | Anticipation counter-moves. |
| `kit.drift` | 0.4, 0, 0.6, 1 | Continuous camera breath. |

**easings.net (Penner families; source `ai/easings.net` src/easings.yml).** Each family comes as `in`, `out` and `inOut`; strength rises Sine < Quad < Cubic < Quart < Quint < Expo; Circ starts or ends abruptly; Back overshoots.

| Family | in | out | inOut |
|---|---|---|---|
| Sine | 0.12, 0, 0.39, 0 | 0.61, 1, 0.88, 1 | 0.37, 0, 0.63, 1 |
| Quad | 0.11, 0, 0.5, 0 | 0.5, 1, 0.89, 1 | 0.45, 0, 0.55, 1 |
| Cubic | 0.32, 0, 0.67, 0 | 0.33, 1, 0.68, 1 | 0.65, 0, 0.35, 1 |
| Quart | 0.5, 0, 0.75, 0 | 0.25, 1, 0.5, 1 | 0.76, 0, 0.24, 1 |
| Quint | 0.64, 0, 0.78, 0 | 0.22, 1, 0.36, 1 | 0.83, 0, 0.17, 1 |
| Expo | 0.7, 0, 0.84, 0 | 0.16, 1, 0.3, 1 | 0.87, 0, 0.13, 1 |
| Circ | 0.55, 0, 1, 0.45 | 0, 0.55, 0.45, 1 | 0.85, 0, 0.15, 1 |
| Back | 0.36, 0, 0.66, -0.56 | 0.34, 1.56, 0.64, 1 | 0.68, -0.6, 0.32, 1.6 |

**Material 3 (Google; source `material-components/material-web` tokens/versions/latest/sass/_md-sys-motion.scss).** Built for interfaces: "emphasized" for the moves that matter, "standard" for utility.

| Name | Bezier |
|---|---|
| `m3.standard` | 0.2, 0, 0, 1 |
| `m3.standardDecelerate` / `Accelerate` | 0, 0, 0, 1 / 0.3, 0, 1, 1 |
| `m3.emphasizedDecelerate` / `Accelerate` | 0.05, 0.7, 0.1, 1 / 0.3, 0, 0.8, 0.15 |
| `m3.legacy` (old Material "fast out, slow in") | 0.4, 0, 0.2, 1 |

Durations: short1 to 4 = 50, 100, 150, 200 ms; medium1 to 4 = 250, 300, 350, 400 ms; long1 to 4 = 450, 500, 550, 600 ms; extra-long1 to 4 = 700, 800, 900, 1000 ms.

**IBM Carbon (source carbondesignsystem.com/elements/motion/overview).** Two modes: productive (efficient, gets out of the way) and expressive (meant to be noticed, used for significant moments).

| | Productive | Expressive |
|---|---|---|
| Standard | 0.2, 0, 0.38, 0.9 | 0.4, 0.14, 0.3, 1 |
| Entrance | 0, 0, 0.38, 0.9 | 0, 0, 0.3, 1 |
| Exit | 0.2, 0, 1, 0.9 | 0.4, 0.14, 1, 1 |

Durations: fast-01 70 ms, fast-02 110, moderate-01 150, moderate-02 240, slow-01 400, slow-02 700.

UI durations are tuned for interfaces seen at arm's length. In video, a move across a 1080px frame usually wants longer than the UI numbers; use them as floors for small moves.

## 3. Springs

`MotionKit.spring({ response, damping })` returns `{ ease, duration }`; use both (the settle time is the physics). Transforms only: a spring passes 1, so never put it on opacity or colour.

| damping | Feel |
|---|---|
| 1.0 | No overshoot, long premium tail |
| 0.8 to 0.85 | Alive, overshoot felt not seen |
| 0.6 to 0.75 | Physical, visible settle (hinges, impacts, landings) |
| below 0.55 | Cartoon wobble; only for a deliberately comic beat |

`response` is the speed: 0.25 to 0.35 s snappy, 0.35 to 0.5 standard, 0.5 to 0.7 weighty.

Other systems' spring models, for translating a reference: Apple (WWDC23 "Animate with springs") describes springs by duration and bounce, bounce from -1 to 1, default 0 (no overshoot), with mass 1, stiffness (2π / duration)², damping 1 - 4π·bounce / duration for bounce ≥ 0. Motion (Framer Motion, motion.dev) defaults: damping 10, mass 1, duration-based bounce 0.25, tween duration 0.3 s.

## 4. Timing

- Duration from distance and weight, not habit: `MotionKit.dur(distancePx, weight)` = (9 + 1.15·√distance)·weight frames at 60 fps; weight 0.7 light, 1 normal, 1.35 heavy.
- Exits run at about 0.6 to 0.7 of the matching entrance and accelerate out.
- Reactions answer a lead at uneven offsets (`MotionKit.react(i)`: 0, 4, 9, 15, 22, 30 frames), not an even stagger. A 1-frame wave across many small items is a different thing and is fine.
- If the piece has music, start phrases on its beats (`MotionKit.grid(bpm)`) and keep reactions off the grid.
- Contrast carries rhythm: a hold makes the next snap land. Nothing should be dead-static unless stillness is the point; a slow drift or living detail keeps holds alive.

## 5. Devices (choose, do not stack)

Each device costs attention. Spend it where the story turns. About one signature transition per piece; the rest of the craft should be invisible. Craft high, devices sparing.

| Device | What it does | Kit |
|---|---|---|
| Arc | x and y on different curves so travel bends | `arc` |
| Anticipation | Small counter-move before a big one | `anticipate` |
| Drag / follow-through | Children lag the parent and settle last | `drag` |
| Spring settle | Physical landing | `spring` |
| Masked reveal | Type rises out of its own baseline | `revealLines` |
| Purposeful exit | Leaves faster than it came, accelerating | `exitTo` |
| Type-on | Stepped character reveal (mono, terminal) | `typeOn` |
| Camera travel | The frame moves to the next idea instead of things exiting | `#cam` wrapper tweens |
| Born from the last thing | The next element grows out of the previous one (match cut, morph) | authored |
| Cause and effect | One element's motion drives another's (playhead drives a count) | function of time |
| Parallax | Layers drift at different rates for depth | authored |
| Motion blur | Shutter smear on fast moves | root `data-motion-blur="on"` `data-motion-blur-shutter="180"` |

## 6. Treatments: what each move is

Curves say how something moves; the treatment says what the move is. Decide it first, per element: how does this line arrive, and why that way? The agent default is to fade and blur everything in; a designer cuts most text on and spends a crafted entrance only where it means something.

**Text in.** Cost is how much attention it pulls.

| Treatment | Reads as | Cost | How |
|---|---|---|---|
| Hard cut (on a beat or the spoken word) | Confident, editorial; the right call for most supporting text | none | `MotionKit.cut(tl, el, t)` |
| Line mask rise | Broadcast title, clean | low | `revealLines` (each line `overflow: hidden`) |
| Word cascade through masks (uneven offsets) | Kinetic but controlled | low-med | `MotionKit.revealWords(tl, el, t)` |
| Character cascade (1 to 2 frames apart) | Energetic; title moments only | med | `splitText(el, 'chars')` then animate the inners |
| Word swap in place | A value or term changing | low | old word exits up through its mask, new one rises in, or cut on the beat |
| Slam from large scale | Emphasis, launch hit | high | scale 1.6 to 3 to 1 on `kit.heavy` or a spring; engine motion blur |
| Tracking settle | Premium, cinematic | med | `MotionKit.trackIn(tl, el, t)` (letter-spacing from wide or tight to set) |
| Weight / width shift | Characterful, brand-specific | med | tween `font-variation-settings` on a variable font |
| Type-on (stepped) | Something literally being typed: terminals, search, code | low in context | `typeOn` |
| Scramble / decode | Data, IDs, hashes, machine output | med | `MotionKit.scramble(tl, el, t, seconds)` |
| Counter roll / split-flap | Numbers, boards, departures | med | text as a function of time (see the playhead-driven count in the lab's C) |
| Highlight or underline wipe | Emphasis on a word already on screen | low | `MotionKit.wipe(tl, bar, t)` |
| Stroke write-on | Handwriting, signatures, diagrams | med | SVG `stroke-dashoffset` |
| Opacity fade | Quiet secondary text, or a crossfade that means "becomes" | low but generic | Never the default |

**Text out.** Cut it, send it out through its mask faster than it came, push it out with the next element, or let the camera carry it off. Fading every line out is the same tell as fading it in.

**Effects.** Each is spent like a signature device; most pieces need none of the ones marked as a look.

| Effect | Status |
|---|---|
| Blur-in / blur-out on type ("blur fade", often with scale 1.1 to 1) | Recognisable AI and template look. Prefer a mask or a cut. Blur belongs to fast motion (engine motion blur), not to appearing. |
| Opacity fade on everything | AI tell: everything feels soft and late. |
| Drifting glow orbs, radial-gradient backdrops | AI landing-page look. |
| Floating drop-shadow cards | Web UI look; fine when the piece is literally showing a UI. |
| Gradient or shimmer text sweeps | SaaS template look. |
| Engine motion blur on fast moves | Native: what a real camera does. |
| Hard cuts, flash frames, colour flips on beats | Native and cheap; underused by agents. |
| Shape masks and wipes | Native. |
| Grain, chromatic aberration, light leaks, halation | A style choice; brand-dependent, never a default. |

Reference vocabulary, for range rather than imitation: After Effects ships text animation presets grouped by type (animate in and out, blurs, tracking, rotation, scale, mechanical, organic, multi-line, paths, lights and optical); Apple's keynote titles lean on cuts, line masks and tracking; kinetic typography leans on cascades, slams and swaps timed to the voice. (Preset groups listed from memory, not checked against a source.)

**Time and procedural tools (from After Effects).** The things a motion designer reaches for in AE that hand-keyed GSAP lacks. All are pure functions of time, so any frame renders the same whether you play or scrub.

| AE tool | What it gives you | Kit |
|---|---|---|
| Text animator range selector | One move swept across a line's characters or words, with a soft edge, a falloff shape and a direction (left, right, centre out, edges in). Cascades, waves and settles become one decision instead of hand staggers. | `textRange(tl, el, t, seconds, { from: { yPercent: 110, rotation: 8 }, width, shape, direction, by })` |
| `wiggle(freq, amp)` | Organic noise: handheld camera breath, a living logo, a jittery readout. Seeded, so it repeats exactly. Keeps holds alive without inventing extra props. | `wiggle(tl, wrapper, { x: 6, y: 4, rotation: 0.5 }, { freq, at, until, seed })`, on a wrapper only (GSAP is not additive) |
| Inertial bounce expression | The move keeps its arrival speed and rings past the target, decaying. Physical landings for things that arrive moving (thrown, dropped, slammed). | `ease: withBounce('kit.leave', seconds, { freq, decay })` |
| `loopOut('cycle' / 'pingpong')` | A move that repeats until a time: spinners, pulses, idle sways. | `loop(tl, el, fromVars, toVars, { period, mode, at, until })` |
| Time remapping (speed ramps) | A section played through a speed curve: race in, slow motion through the hit, race out. One of the most recognisable editorial moves. | build the section on its own paused timeline, then `ramp(tl, section, t, seconds, 'ramp.slowMid' / 'ramp.speedUp' / 'ramp.slowDown')` |
| Null + pick-whip (parenting, linked properties) | One controller value drives many properties: the playhead drives the count, the bar and the glow together. Cause and effect by construction. | `const ctl = controller({ from, to, at, duration, ease })`, then `link(tl, ctl, el, (v) => ({ ... }))` per target |

Like every device, these are spent where they carry the story. A wiggle on everything is the new fade-on-everything.

## 7. Other engines

- **CSS / WAAPI:** `cubic-bezier(x1, y1, x2, y2)` with the same numbers.
- **Blender F-curves:** set both keys' handle types to FREE. For a segment from (f0, v0) to (f1, v1) with bezier (x1, y1, x2, y2): right handle of the first key = (f0 + x1·(f1 − f0), v0 + y1·(v1 − v0)); left handle of the second key = (f0 + x2·(f1 − f0), v0 + y2·(v1 − v0)). Key a camera and whatever it follows on the same frames and curve, or they drift apart.
- **three.js / canvas:** drive values from a GSAP timeline or call the kit's `bez(...)` function on normalized time.
- **3D cameras (Blender, three.js):** a camera is not a tweened object. Each move is a velocity profile: a short rise (or none, when the shot cuts in already moving), a long settle that lands just before the payoff, then a slow drift along the same heading until the cut, never a dead stop. Interpolate orbit parameters (target, distance geometrically, azimuth, elevation, lens) so arcs stay arcs, and key the camera every frame.

## 8. Check

Scrub the timeline frame by frame (HyperFrames Studio, or `tl.seek()`) and ask:

- Does any tween use a named preset (`power3.out`, `ease`, `sine.inOut`) because it was the default? Replace it with a curve chosen for that move.
- Do several elements start on the same frame, or 0.08 s apart in an even line? Give them a lead and uneven reactions.
- How does each piece of text arrive? If most of them fade in, cut most of them on.
- Do exits run faster than their entrances, and accelerate out?
- Is anything dead still for more than about a second when stillness is not the point?
- Count the devices. More than one signature transition, or a device on every beat, is too many.
