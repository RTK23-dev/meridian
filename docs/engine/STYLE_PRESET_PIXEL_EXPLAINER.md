# Style preset: the 8-bit science explainer

The preset is `pixel_explainer` (`src/engine/presets/pixel-explainer.ts`). It was built on 2026-11-06 from a study of 14 reels of one account. It is the first style that runs end to end on the directed pipeline:

1. a Director writes the full direction;
2. the checks refuse what is described rather than directed;
3. a code-drawn crew builds it;
4. the take is measured against its direction.

Agent mode runs all of it today with no provider call (`.claude/skills/pixel-explainer/SKILL.md`).

## 1. What was built

| Part | Where | What it does |
| --- | --- | --- |
| The directed film | `src/engine/direction/film.ts` | The Director's output. It holds the locked look and, for every shot, the seven parts of direction (L1): one moment and when it hits, the arc, the cadence, the eye target and the empty band, the loop, and the avoid list. It also holds the cards, the moving numbers, the claims with their sources, the call to action and the loop. It is the proposed ShotDirection contract (`docs/engine/proposals/SHOT_DIRECTION.md`); it is not yet an engine contract |
| The direction check | `src/engine/direction/check.ts` | Scores the film before anything is spent (L2's real director_check). See the block and warn lists below |
| The compiler | `src/engine/direction/compile.ts`, `motion-vocab.ts` | A generated shot's provider prompt and negative prompt, compiled from its direction with phrasing per provider family (L5, untested until a live run). It also places the sound cues: a hit on every moment, a blip on every card, ticks on a count and a chime on the call to action (L4, L11) |
| The crew's faithfulness | `src/engine/direction/faithful.ts` | The crew may not change the direction (L2): every moment is built at its time, the subject sits on its eye target and out of the words' band, and the loop seam is closed |
| The take check | `src/engine/direction/take-check.ts` | Measures each take against its direction: the moment visible within 200 ms of its time (a peak, or on a moving camera a jump in the motion), the loop distance at most 0.04, subject drift, palette drift from the reference frame, and avoided items seen (L4, L6, L7, L8, L9) |
| The pixel crew | `src/engine/compose/pixel/` | The stage vocabulary (`stage.ts`) and the engine (`pixel-engine.js`). The engine draws a 180 x 320 logical frame scaled by a whole number, ordered-dither shading, outlines, faces with expressions, a 5x7 bold pixel font, glows and grain. Characters move on twos, the camera on ones, and moves wind up, whip and settle on the motion kit's curves. It is seek-safe: every frame is a pure function of time |
| The agent renderer | `scripts/engine/pixel-explainer/` | `check.ts` and `render.ts` (frames in the local Chromium, an original synthesised chiptune bed with the cues, mastered to -14 LUFS, then measured). `bench.ts` renders the directed film and its described control side by side (L12) |
| The prompts | `src/engine/prompts/shot_director@1.md`, `pixel_crew@1.md` | The Director and the code-drawn crew, in the four parts every role prompt has |
| The orchestrator | `src/engine/prompts/orchestrator_plan@5.md`, `src/engine/orchestrator/direction.ts` | v5 plans the video in order: Director, then fact-check, then one picture step per named shot (or the pixel crew), then take review, then render. A plan whose pictures are not directed is accepted with a note that says so |
| The preset | `src/engine/presets/pixel-explainer.ts` | The style kit, the measured and read grammar, the beat template, the shot wants, the gaps, and `PIXEL_EXPLAINER_DIRECTION` (the Director's template: formats, timing, card rules, worlds, faces, sound and crew recipes) |

**The direction check blocks:**

- shots that do not tile the film;
- a moment outside its shot;
- an arc that does not contain the moment;
- a look whose reference shot is missing;
- an eye target in the words' band;
- a card over the subject;
- a line with no picture;
- a number in no sourced claim, or a claim with no source;
- an answer after 3 s;
- a card-clocked film with no words at frame 0;
- a looping film whose last shot does not land on frame 0;
- a call to action after the end.

**The direction check warns on:**

- a card too short to read;
- more than 3 words a second;
- a moment nothing readable marks;
- a silent moment;
- a shot over 10 s;
- no re-hook between 4 and 7 s;
- no "X = Y" card;
- an avoid list that only repeats the global one;
- an early call to action.

## 2. The study


A study of 14 reels from the account: 6 pinned and 8 others. **This is only a 14-video partial sample.** It is not an archive, and the 8
are not a verified chronological latest-8. Two of the 14 are ads for the account's studio (DfWlPu3FTcE, DfWy3_RiY5i). The other 12 are
science shorts, and those 12 carry the formula below. Each video's full record (`CODE.json`, one schema for all 14) was
delivered with the study and is not stored in the repository, because it quotes the reels' on-screen text.

**How each claim is sourced:**

- **measured**: ffmpeg and numpy on the compressed copies (480x854, 30 fps), and faster-whisper (medium.en) for speech.
- **read**: read from the frames by the coding agent (1 fps contact sheets, 2 fps hook strips, native-resolution crops). Times are
  ±0.5 s.
- **inferred**: says so where used.
- Each claim cites `code @ seconds`.
- On-screen text is quoted as it appears.
- I added no numbers. Every number below is from a measurement, from the index, or is on screen in the video named.

### 2.1 The shared formula (the 12 science shorts)

| Part | What they do | Evidence |
| --- | --- | --- |
| Length | 31 to 36 s; one runs 52 s | measured: median 32.1 s (DeyG894q-ga is 52.1 s) |
| Voice | **None.** Text cards carry the whole explanation over music | measured: no speech in 12 of 12. Whisper only produced its usual music hallucinations ("thank you for watching"), which were dropped. Only the two ads have a voice-over |
| Text on screen at frame 0 | 12 of 12 | read, hook strips at 0.0 s |
| The answer, flip or event | lands at 0.5 to 3.0 s (median 2.0 s) | read. The flip is "0% THICKER." (DfXJJIGkhtD @1.5), a green-to-orange colour flip with "IT'S SHOUTING." (DfW0jw1DNts @2.0), "40 KM/H FROM ANY HEIGHT" (DfXd1QugiSd @3.0) and "IS A BUBBLE BORN" with the bubble popping in (DfIqOKUCneZ @1.5) |
| Text cards | median 12 per video; held for a median 2.6 s; about 2 words a second | derived from the read cards: 1.3 to 2.9 words/s |
| Card grammar | at most 2 lines, all caps, a bold pixel font, white with a dark outline; the payoff word in yellow | read. Yellow measured at #F4CE44 (per-channel median of the 12; range #EFD73E to #FCBE50) |
| "X = Y" or "X: Y" cards | 11 of 12 | read: "FASTER = MORE AIR PUSH" (DfXd1QugiSd @6), "BLUE + YELLOW = GREEN" (DfW0jw1DNts @23), "SECONDS ÷ 3 = KM" (DfBk_EenL20 @20), "WARM NOSE: FULL SWARM" (DfWgAn2DvOO @25). The exception is DfEeekmgjHs |
| One line, one literal picture | every card has a picture that does what the card says | read: each CODE.json has a `sentenceToPicture` list. For example, a cyan AIR arrow grows to match a red WEIGHT arrow for "AIR PUSH = WEIGHT" (DfXd1QugiSd @9); a soda icon beside the bones for "LIKE OPENING A SODA" (DfIqOKUCneZ @6) |
| Characters | objects and body parts get two round eyes (white, black pupil, highlight), a line mouth and brows. The expression follows the stakes | read in 12 of 12: lungs strain as CO2 piles up (DeyG894q-ga @22-38); the salt shaker's angry brows (DfWLbwvlDws @3) |
| Scale change as the cut | 8 of 12 dive into a smaller world and come back. 2 more change scale outward | read: under the skin (DfXJJIGkhtD @14), through skin to crystals (DfW0jw1DNts @7-10), into the nose (DfWgAn2DvOO @2), into the water (DfWLbwvlDws @9), down the throat (DfEeekmgjHs @13.5), into the ear (DfEy_XqFMj5 @0-2), into the tissue (DfGuj5uo7EO @9), along a vessel (DeyG894q-ga @4); crane up (DfBk_EenL20 @4); pull back (DfXd1QugiSd @5) |
| Few hard cuts | median 2 cuts at scene score 0.3. The picture changes by camera moves and dives | measured: 1 to 8 per video. DfXd1QugiSd has a single hard cut, at 22.5 s |
| Numbers that move | a counter, timer, countdown or readout changes on screen in 9 of 12 | read: speed 4 to 40 KM/H (DfXd1QugiSd @0-3), a 0:00.23 timer (DeyG894q-ga @0), a 20 to 1 countdown (DfEeekmgjHs @1), 8,000 to 16,000 Hz (DfEy_XqFMj5), a 20:00 reload timer (DfIqOKUCneZ @3), liver size 55% to 100% (DfGuj5uo7EO @16-21) |
| Concept colours | two opposing things get two fixed colours | read: red WEIGHT and cyan AIR (DfXd1QugiSd @6), blue O2 and grey CO2 (DeyG894q-ga @9), a blue cold front over red tissue (DfWgAn2DvOO @10) |
| Honesty on screen | approximations, safety lines and a small source line under numbers | read: "(ON AVERAGE)" (DfEeekmgjHs @28), "~20 MIN" (DfIqOKUCneZ @13), "LAB TESTS ON NOSE CELLS" (DfWgAn2DvOO @21), "1 TSP IN A 4 L POT" (DfWLbwvlDws @22), "NEVER PRACTISE IN WATER." (DeyG894q-ga @50), "FUN TEST, NOT MEDICAL" (DfEy_XqFMj5 @12), "WHEN THUNDER ROARS, GO INDOORS." (DfBk_EenL20 @27) |
| A joke beat | a speech bubble or a "...NOTHING." | read: "NO PROBLEM." (DfGuj5uo7EO @2), "AND ME?" / "NOPE." (DfGuj5uo7EO @28), "NOPE!" (DfEeekmgjHs @11), "CRACK IT AGAIN? ...NOTHING." (DfIqOKUCneZ @11) |
| Loop | **12 of 12 are frame loops.** The first and last frames differ by 0.006 to 0.022 (Meridian's loop test allows 0.04). 9 of 12 also bring back the hook text or the opening event | measured (`loopDistanceFirstToLastFrame`). The ads measure 0.10 and 0.54 |
| Watermark | inside the world, not an overlay | read: a sign on a building (DfXd1QugiSd @16), engraved on the pot (DfWLbwvlDws @4), a tag on the thermometer (DfWgAn2DvOO @3) |
| Sound | music under everything, mastered to -14 LUFS. Ticks land on the counted seconds | measured: integrated -14.4 to -14.1 LUFS, range 6.1 to 10.0 LU. Transients fall at 0.93, 1.93 and 2.93 s while "1 SEC, 2 SEC, 3" count on screen at 1.0, 2.0 and 3.0 s (DfBk_EenL20). Tempo estimates cluster at 117.5 (8 of 12) and 80.7 bpm (approximate). A real 8,000 Hz tone plays at 0-4 s and 10,000 Hz at 6-7 s (DfEy_XqFMj5) |
| Caption | claim, then 🎧, then 2 to 3 short paragraphs, then `Sources:` with 3 sources, then "Send this to the friend who...", then follow, site and 4 hashtags | read in the 8 science captions present. 5 index rows have empty captions |
| Posting cadence | the 5 dated consecutive posts are 3 hours apart | as indexed: 2026-11-04 22:31, 11-05 01:31, 04:30, 07:30, 10:31 (UTC-6) |

**The look:**

- **Ground:** dark and cool. Mean picture luminance is 0.15 to 0.34 in 11 of 12 (measured). The exception is the peach desert of
  DfXJJIGkhtD, at 0.44. Navy or indigo (#10183F to #272A6B) is the largest colour in 7 of 12 (measured palettes). The rest use plum,
  maroon or jungle teal.
- **Subject:** warm. Orange, pink, peach and gold are set against the cool ground.
- **Rendering:** clean shapes with checker and stipple dither shading, soft glows around the key object and a fine grain over the
  whole frame. It is not native low-resolution pixel art (inferred from native-resolution crops). The "8-bit" read comes from the font,
  the dither and the limited palette.

**The structure:**

| Time | Beat |
| --- | --- |
| 0-3 s | Hook card plus an event, then the flip |
| 3-6 s | The first "why", often a one-word question or a twist ("WHY?" DfXd1QugiSd @5, "BUT THE MISSING PART NEVER GROWS BACK" DfGuj5uo7EO @4, "SO WHAT DOES SALT ACTUALLY DO?" DfWLbwvlDws @7) |
| 6-22 s | The mechanism inside the dive: 4 to 6 cards, one picture each |
| 22-27 s | Proof numbers, with a counter or a source line |
| 27-30 s | The payoff line with a yellow keyword, then the CTA |
| last 1-2 s | Back to frame 0 |

### 2.2 Pinned against the others: the craft only

Performance is **unverified**. The indexed view counts are not comparable:

- The 5 dated "other" posts were indexed within hours of going up (857 to 72,519 views).
- The pinned posts have no date, so their age is unknown.
- The account chose which posts to pin, so the pinned set may be a selection of its best, not a sample (inferred).

The differences below are differences in craft. They are not causes of views.

| | Pinned (6) | Other science (6) |
| --- | --- | --- |
| Participation device (a timer, countdown, count-along or test) | 4: DeyG894q-ga, DfEeekmgjHs, DfBk_EenL20, DfEy_XqFMj5 | 1: DfUObncjJfa |
| Flip time, median | 1.5 s | 2.0 s |
| On-screen words a second, median | 2.1 | 1.7 |
| Card hold, median | 2.9 s | 2.6 s |
| CTA | comment a result (3), safety rule (1), share (1), joke button (1) | share (3), comment (1), advice (1), none (1) |

### 2.3 A reusable direction template (8-bit science explainer, 30 to 36 s, text-led)

1. **One idea.** A misconception, an everyday sensation, or a test the viewer can do now.
2. **Hook (0 s).** Two-line card plus the world plus an event already moving. Use a named belief ("YOU THINK...?"), a dare ("DON'T
   SWALLOW..."), an extreme number ("...LOSE 70%") or an everyday thing named ("YOUR KNUCKLE CRACK").
3. **The one moment of the hook shot at 1.5 to 3.0 s.** The answer or flip, as a visible change (a colour flip, a pop, a number
   settling). It gets a sound.
4. **Re-hook at about 5 s.** A one-word question, a "but" twist or a change of scale.
5. **The mechanism.** 4 to 6 cards of at most 2 lines, about 2 words a second, held 2 to 3 s. Each card has one literal picture. At
   least one card is "X = Y". Two opposing concepts get two fixed colours.
6. **Proof.** A number that moves (counter, timer or readout), with a small source line or an approximation mark.
7. **Payoff.** One line with the yellow keyword. Then the CTA: a person to send it to, a result to comment, or a safety rule.
8. **Return.** The last 1 to 2 s return to frame 0, so the end runs into the start (loop distance at most 0.04).
9. **Sound.** A music bed at -14 LUFS, a tick on every counted unit and a hit on every one moment.
10. **Each shot holds:**
    - one world;
    - a locked or slow camera;
    - one subject with a face;
    - the eye target;
    - an empty band for the text: the upper third, or the lower third when the subject is high.

### 2.4 What Meridian takes from this, beyond L1 to L13

Each lesson below adds to the direction lessons L1 to L13 (MERIDIAN_DIRECTION_LESSONS.md):

- **L14. Answer by 3 seconds.** The hook shot's one moment is the answer or flip, at 1.5 to 3.0 s (12 of 12). This is a direction
  check.
- **L15. Text can be the voice.** A text-led film times every card by reading speed (about 2 words a second, held 2 to 3 s). The
  voice is optional, so the voice clock of L4 becomes the card clock.
- **L16. A change of scale is the cut.** Dive in and back out, instead of hard cuts (8 of 12). This is a camera move in the shot
  direction.
- **L17. Numbers move.** A counter, timer or readout that changes on screen (9 of 12), with a tick on each unit (DfBk_EenL20).
- **L18. Participation devices.** A dare, a count-along or a test with a persistent readout (4 of 6 pinned). This is a format option,
  with a safety line when the body is involved.
- **L19. Equation cards and concept colours.** "X = Y" cards (11 of 12) and fixed colours for opposing concepts.
- **L20. Honesty on screen.** Approximation marks, a small source line under a number, and three sources in the caption.
- **L21. Characters by faces.** One face system (eyes, line mouth, brows) on any object. The expression is keyed to the stakes.
- **L22. Frame loops by construction.** The last shot is directed to land on frame 0 (12 of 12 measured).
- **L23. A fact-checker between Director and Crew.** The studio ad shows "sources for every claim" as its own step (DfWy3_RiY5i
  @12).


## 3. The first film from the preset (made in agent mode)

The film is "Microwaves cook from the inside? Nope. They shake water." It is directed in `src/engine/direction/fixtures/microwave.film.json` and built in `microwave.build.json`.

It has seven shots:

1. a smug soup bowl in a microwave that zaps at 2.5 s;
2. a dive into the soup that hits the surface on the beat;
3. lopsided water droplets that snap to a red field arrow, the lead first;
4. the field mirroring back and forth until a readout slams in at 2,450,000,000;
5. the jostling droplets flushing orange, with steam and a thermometer;
6. the bowl from above, a cold blue middle with a worried face warmed by a spoon;
7. back in the kitchen, the beep, and the last frame back on frame 0.

Its claims and sources:

- **2,450 MHz:** US FDA, Microwave Ovens; HyperPhysics.
- **Polar water and dielectric heating, a simplified picture:** HyperPhysics.
- **Cold spots, stir midway:** USDA FSIS, Cooking Safely in the Microwave Oven.

**Measured on the render** (agent renderer, 720x1280, 30 fps, 960 frames):

| Measure | Value | Study / bar |
| --- | --- | --- |
| Direction check | passes; 2 warnings | two moments, the dive's splash and the beep, are marked by a sound and an effect, not a card |
| Crew faithfulness | passes; 1 warning | at the end of the dive the soup's surface fills the frame, words band included |
| Take check | every moment visible | judged in the picture outside the words' band |
| Loop distance | 0.002 | study 0.006 to 0.022; bar 0.04 |
| Mean motion | 0.0117 | study median 0.0123 |
| Integrated loudness | -14.5 LUFS | study -14.4 to -14.1 |

**The round of fixes before this render.** These came from reading the stills and the 2 fps sheet:

- **Fixed in the engine:**
  - a broken glyph;
  - the keyword flashing white on frame 0;
  - faces that turned with their bodies (they now stay level);
  - a thin font (now bold).
- **Fixed in the direction:**
  - a flip that spun through the words (it is now a mirror);
  - a sparse field (now 5 by 5 larger droplets);
  - a small subject (the microwave now fills the width);
  - a dive whose splash did not read: the take check refused it, and the camera now hits the surface at speed and stops on the beat.

**The directed-versus-described benchmark** (`bench.ts`, L12) is filled in by the follow-up commit.

## 4. What is still the owner's

- **The ShotDirection contract.** Moving it from `direction/film.ts` into `src/engine/contracts/` (proposal: `docs/engine/proposals/SHOT_DIRECTION.md`) needs the owner's or lead's approval, a version bump and a Bible section 4 note. Until then:
  - the direction does not pass between engine stages;
  - `produce_shot` does not compile from it.
- **The shot_director and pixel_crew roles.** `ClaudeRole` is a contract enum, so the Claude client cannot call the two new prompts as roles yet. Agent mode and orchestrator v5 use them now.
- **A pixel.scene compose component.** The engine's render path would need one to draw the stages inside a HyperFrames composition, with goldens. Today the pixel crew renders in agent mode.
- **A snap-to-look media function** (L6), for generated stills in this style.
- **A live run.** The provider phrasing in `motion-vocab.ts` is untested until a recorded live run on Kling, Seedance or Wan.
