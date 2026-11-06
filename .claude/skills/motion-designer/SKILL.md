---
name: motion-designer
description: Author motion like a motion designer instead of with named presets. Read before animating anything (HyperFrames or any GSAP timeline, CSS, three.js, Blender keys). Replaces the house default (power3.out, fade up 24px, 0.4 to 0.6 s, even 0.08 s staggers, static holds) with hand-shaped curves per property, duration from distance and weight, a lead with uneven reactions, and text that mostly cuts on. Ships motion-kit.js, a seek-safe GSAP helper with every curve by name.
---

# Motion designer

Agent-made video has a look, and it comes from defaults: every element fades up about 24 px on `power3.out` over 0.4 to 0.6 s, 0.08 s apart, then nothing moves. HyperFrames' own animation guide writes that down as its house default (`gsap.defaults({ duration: 0.6, ease: "power3.out" })`). This skill overrides it. When it conflicts with another skill's motion numbers, this one wins; take structure from those skills, never curves or timing.

You are the motion designer. Decide what the piece should feel like, then choose. Two pieces should not come out moving the same.

## Work loop

1. Read `LIBRARY.md` (beside this file): registers, curves, springs, timing, devices, text treatments.
2. Pick a register for the piece (technical, editorial, premium, expressive, playful, calm). Mixing is fine; one expressive moment in a technical piece is normal.
3. For each element, decide what its move **is** before how it eases (LIBRARY section 6): does this line cut on, type on, settle its tracking, or get thrown in? Most supporting text cuts on.
4. Vendor `motion-kit.js` into the composition (`assets/motion-kit.js`, loaded after GSAP) and author with it.
5. Scrub the result frame by frame and run the checks in LIBRARY section 8.

## Rules

- **No named presets as defaults.** Not `power1` to `power4`, not CSS `ease`, not a framework default. Every curve is chosen for the move: `MotionKit.curve('kit.land')`, a system curve (`m3.emphasizedDecelerate`, `carbon.expressive.entrance`), or your own `MotionKit.bez(x1, y1, x2, y2)`.
- **A curve per property.** x and y can differ (`arc`), so travel bends the way a thrown thing does.
- **Duration from distance and weight**, not a 0.3 to 0.6 s habit: `MotionKit.dur(px, weight)`.
- **Exits are quicker than entrances** (about 0.65x) and accelerate out (`kit.leave`, `exitTo`).
- **A lead and its reactions**, at uneven offsets (`MotionKit.react(i)`: 0, 4, 9, 15, 22, 30 frames), never an even stagger.
- **Holds stay alive** (a slow camera drift, a `wiggle` on a wrapper, a living detail) unless stillness is the point.
- **Text:** written text (a quote, a prompt, a terminal line) types out character by character (`typeOn`); other text cuts on (`cut`) or settles its tracking (`trackIn`). Masked rises from below and blur-ins are the most overused moves in agent video; reach for them last.
- **No AI looks:** fade-everything, blur-in type, drifting glow orbs, shimmer text. Blur belongs to fast motion (render-time motion blur), not to appearing.
- **Restraint.** A device (dive, flip, pop, spring, type-on) earns its place by carrying the story. About one signature transition per piece. Craft every move high; spend devices sparingly.
- **Overshoot is a choice, not a garnish.** Editorial and product pieces usually want decelerating curves and springs at damping 1. Bounces read cheap when they are on everything.

## The kit (motion-kit.js)

Seek-safe: everything is `fromTo` on a paused timeline, nothing reads the previous frame, so any frame renders the same whether you play or scrub.

| Call | What it does |
|---|---|
| `curve(name)`, `bez(x1, y1, x2, y2)` | every curve in LIBRARY by name, or your own bezier |
| `dur(px, weight)` | duration from distance and weight (0.7 light, 1 normal, 1.35 heavy) |
| `react(i)` | uneven reaction offset for the i-th follower |
| `arc(tl, el, from, to, at)` | travel on a bent path (x and y on different curves) |
| `anticipate(tl, el, prop, from, to, at)` | small counter-move, then the move |
| `drag(tl, child, prop, lagPx, at, parentDur)` | child lags its parent and settles last |
| `exitTo(tl, el, to, at)` | quicker, accelerating exit |
| `spring({ response, damping })` | physical spring; returns `{ ease, duration }`, transforms only |
| `cut`, `typeOn`, `trackIn`, `scramble`, `wipe`, `revealWords`, `revealLines`, `textRange` | text treatments |
| `wiggle`, `withBounce`, `loop`, `ramp`, `controller` + `link` | After Effects tools: seeded wiggle, inertial bounce, loopOut, time remap, null + pick-whip |
| `grid(bpm)` | beat times, for phrases that start on the music |

```html
<script src="assets/gsap.min.js"></script>
<script src="assets/motion-kit.js"></script>
<script>
  const { C, F, curve, dur, react, arc, cut, trackIn } = MotionKit;
  const tl = gsap.timeline({ paused: true });
  cut(tl, '#sub', 0.6);                                   // supporting text just arrives
  trackIn(tl, '#title', 0.2, { from: '0.3em' });          // the title settles its tracking
  ['#a', '#b', '#c'].forEach((el, i) =>                   // a lead and its reactions, thrown on arcs
    arc(tl, el, { x: 900, y: 80 }, { x: 0, y: 0 }, 1.1 + react(i)));
  window.__timelines = window.__timelines || {};
  window.__timelines['root'] = tl;
</script>
```

Curves are plain cubic-beziers, so the same numbers work as CSS `cubic-bezier()`, an After Effects speed graph or Blender F-curve handles (LIBRARY section 7).

In Meridian, read `MERIDIAN.md` beside this file first: where the kit lives in compositions, the motion lint, and the rules for cues.
