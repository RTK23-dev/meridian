# The Viral Direction Framework

Version 2, 2026-11-04 (codex `direction-codex@2`). Status: reference for Meridian's creative direction agents (script writing, creative and visual direction,
critique). It sets no engine behaviour by itself. The machine-readable part is `src/lib/meridian/direction/` (the direction codex); every
rule there names the section of this document it comes from. Evidence is in [`EVIDENCE.md`](./EVIDENCE.md), the plan to wire it into
Meridian is in [`INTEGRATION.md`](./INTEGRATION.md), and the research programme is in [`RND_PROGRAM.md`](./RND_PROGRAM.md). Version 2
adds 147 short-form lessons from one creator's 274 posts; [`LESSONS_CROSSWALK.md`](./LESSONS_CROSSWALK.md) says where each one lives.

## 0. How to read this

**What it is for.** Most AI video pipelines produce content that is correct and forgettable: a clear script, clean pictures, and a viewer
who swipes at second one. This framework is the difference between that and a video someone holds closer, watches twice, and sends to a
friend. It is written for agents first: each section ends in rules an agent can follow and a check can measure.

**Evidence labels.** Every claim carries one:

| Label | Meaning |
| --- | --- |
| `sourced` | A platform's own statement, or a peer-reviewed or replicated finding. The source is in `EVIDENCE.md`. |
| `practice` | Consistent creator and editor practice, with no controlled study behind it. |
| `hypothesis` | Our reasoning from the sourced material. To be measured by the learning loop before it becomes a rule. |
| `contested` | Evidence exists against it, or the findings disagree. Do not build on it alone. |

**What it never permits.** No invented claims, numbers, testimonials or results (AGENTS.md rule 1). No engagement bait. No copied words,
footage, voice or music (Bible principle 4: copy genes, never content). No misleading hooks. No undisclosed AI people where the platform
asks for disclosure. A video that wins attention by deceiving the viewer loses on every signal that follows: completion, sends, comments,
and the account's trust.

## 1. The core model: every second is a vote

### 1.1 The swipe decision

A viewer in a feed is not choosing between your video and nothing. They are choosing between your next second and the next video, which
the platform has already picked to be good for them, and which is one thumb movement away. `hypothesis`

So the viewer keeps running one comparison, consciously or not:

> **Stay while** the value they expect from the next seconds (what they will learn, feel or get) is higher than what they expect from the
> next video, after the effort it takes to follow yours.

Four things follow from that comparison, and the rest of the framework is built on them:

1. **Every second has to earn its place again.** No moment is safe: an intro, a pause or a slow sentence is a moment where the next video
   wins. `hypothesis`, consistent with the platforms' own retention advice (`sourced`, 2).
2. **Clarity reduces effort.** A viewer who has to work out what is happening pays a cost, and the next video costs nothing.
   Processing fluency makes content feel easier and better (Reber, Schwarz and Winkielman 2004, `sourced`).
3. **Curiosity raises the expected value.** An open, specific question the viewer wants answered makes the next seconds worth more than
   the next video. Curiosity recruits the reward circuit and improves memory for the answer (Gruber, Gelman and Ranganath 2014,
   `sourced`). It is driven by the gap between what the viewer expects and what they get, the "information prediction error" (`sourced`).
4. **Delivered payoffs build credit.** Each payoff that beats its promise makes the viewer trust the next promise, so they stay longer,
   watch again and follow. Each broken promise spends that trust, for this video and the account. `hypothesis`

### 1.2 The decision is fast and visual

On a mobile feed, people spent about 1.7 seconds on a piece of content on average, and recalled it at a significant rate after 0.25
seconds of exposure. About 47% of a mobile video's value was delivered in its first three seconds (Facebook IQ and Fors Marsh, 2016 to
2017, `sourced`, old). The stop happens before any sentence is understood. It is decided by what the eye catches.

What the eye catches is not random:

- **Change and motion.** Cuts, onsets and movement trigger an orienting response, an automatic shift of attention that costs the viewer
  processing capacity (Lang's limited-capacity model, `sourced`).
- **Surprise.** Human gaze goes to what changes the viewer's beliefs, not merely to what is rare: 72% of gaze shifts went to locations more
  surprising than average, while people watched television (Itti and Baldi 2009, `sourced`).
- **Faces and eyes, people in motion, and high contrast** draw early fixation. `practice`, consistent with the attention literature.

### 1.3 The five moments

A video that keeps people watching passes five moments. Each has a job, a failure, and a measure.

| # | Moment | Window (initial) | Its job | How it fails | What the platform sees |
| --- | --- | --- | --- | --- | --- |
| 1 | **Stop** | 0 to about 1.5 s | Break the scroll with something the eye cannot ignore. | Logo, intro, a calm establishing shot, a face saying "so". | Chose to view vs swiped away (Shorts) `sourced` |
| 2 | **Promise** | by 3 s | Say, or show, what the viewer gets and why it is for them. Open one specific question. | Vague promise, or the answer given away. | Intro retention, 3 s retention |
| 3 | **Hold** | 3 s to the payoff | Escalate. Each beat gives a small reward or raises the stakes. | A flat middle: a list with no rising stakes, a tangent, a repeated point. | The slope of the retention curve |
| 4 | **Payoff** | the last third | Deliver more than was promised, at the emotional peak. | Late, small, or a bait-and-switch. | Completion, likes |
| 5 | **Spread** | the end and after | Give a reason to watch again, to send, to save, to say something. | An outro, a "thanks for watching", a generic call to action. | Replays, sends per reach, saves, comments |

The windows are initial values, from the platforms' own hook guidance (TikTok: the proposition in 3 s, the hook within 6 s; Instagram: the
first 3 s; `sourced`). They live in configuration and the learning loop tunes them.

### 1.4 Lean in and watch twice

The user's target is precise: not only a video that is not skipped, but one that makes a person bring the phone closer and watch it twice.
Those are two distinct behaviours with distinct causes. `hypothesis`, built from the sourced mechanisms above.

**Leaning in** happens when the video asks for more attention than it gets by default, and pays for it:

- **Detail density:** more on screen than one viewing can take in (a fast sequence, small but legible detail, a hidden element).
- **A question the picture can answer:** "what is that?", "how did they do that?", "wait, is that real?".
- **Stakes the viewer cares about:** something can go wrong, for someone they identify with.
- **Ambiguity with a promised resolution:** the viewer sees something they cannot yet explain and expects to.

**Watching twice** happens when the end changes the beginning:

- **A payoff that recontextualises the opening.** The twist makes the first seconds mean something new, so the viewer goes back to check.
- **A loop seam.** The last line or frame joins the first, and the video restarts before the viewer decides to leave. Shorts count every
  start and replay as a view since 31 March 2025 (`sourced`, secondary reports), and replays read as a strong signal on TikTok (`practice`).
- **Pace above one viewing.** The video is slightly too fast to take in fully once, and rewarding enough to repeat.
- **Pleasure in the form itself.** A satisfying process, a perfect match cut, a sound that lands on the beat.

**Sending** happens when the video says something about the sender or their relationship. "This is so you", "this is us", "you need this".
Sends per reach is the signal Instagram's head names as most tied to reach among non-followers (Mosseri, 2024 and 2025, `sourced`,
secondary report). High-arousal emotions, awe, amusement, anger and anxiety, increase sharing, and sadness decreases it (Berger and Milkman
2012, `sourced`).

## 2. What the platforms measure

What follows is what the platforms say they read. Section 1 is why viewers behave as they do. This is how that behaviour reaches the
algorithm. Details and dates are in `EVIDENCE.md`.

| Platform | What the platform says it reads | What it means for direction |
| --- | --- | --- |
| Instagram | Watch time, likes per reach, sends per reach (Mosseri, January 2025, `sourced`, secondary). Engagement bait and giveaways can limit distribution (Instagram creators FAQ, `sourced`). Originality: serial aggregators lose discovery reach; reposts are replaced by the original in recommendations (2024 Reels, extended April 2026, `sourced`). | Design for the send. Never bait. Make every video plainly original: a remix needs commentary, a new angle or added craft. |
| TikTok | User interactions (watch time, completion, replays, shares, comments, follows), video information, and device settings (TikTok newsroom, `sourced`, secondary). Follower count is not a direct factor (`sourced`, secondary). Sound is part of the product: 88% of users said sound is essential (Kantar for TikTok, `sourced`, commissioned). | Completion for short videos, absolute watch time for longer ones. Design the audio as part of the idea. |
| YouTube Shorts | Views count every start and replay; engaged views keep the stricter count and decide monetisation (March 2025, `sourced`, secondary). Studio shows how many chose to view vs swiped away (`sourced`, secondary). Mass-produced and repetitive content is not monetised (July 2025 policy clarification, `sourced`). | The first frame is the gate. Loops count. Templated volume is a liability, not a strategy. |
| All | Strong retention early in the video, studied on the retention graph: a flat line is held attention, a sharp drop is an exit, a spike is a rewatch (YouTube Help, `sourced`). | The script is designed as a retention curve, not as a paragraph. |

**What this means for AI-made content in particular.** The platforms now penalise exactly what a naive AI pipeline produces: templated,
repetitive, mass-produced videos with generic voices. Studies of TikTok also find that AI-generated and AI-labelled videos receive less
liking and sharing (2025 to 2026 studies, `sourced`, abstracts only; see `EVIDENCE.md`). Meridian's answer cannot be volume. It has to be
originality, human value and craft, with disclosure where the platform asks for it. `hypothesis` built on `sourced`.

## 3. The Lean-In Score: what a strong video is made of

The Lean-In Score (LIS) is the rubric every direction agent writes toward and every critic scores against. It has fourteen scored
dimensions in four groups, and two floors that are not scored but gate. It is the codex's `RUBRIC`.

### 3.1 The two floors (gates, not scores)

- **Trust floor.** No invented claim, no bait-and-switch, no fake urgency, no misleading thumbnail or first frame, no engagement bait, the
  hook's promise is paid. A video below the floor is not published, whatever its score.
- **Originality floor.** Not a copy of a reference's words, footage, voice or music, not a near-repeat of the brand's own recent hooks, and
  not a template clone the platform would treat as mass-produced. A video below the floor is rewritten.

### 3.2 The fourteen dimensions

Each scores 0 to 4 against the anchors in the codex. The weights in the codex are priors (`hypothesis`) until the learning loop fits them to
outcomes (section 13).

| Group | Id | Dimension | 4 means | 0 means |
| --- | --- | --- | --- | --- |
| Stop | `stop_frame` | First-frame stopping power | Frame 0 has motion, a face, contrast or an impossible image, and reads without sound | A logo, title card, or static establishing shot |
| Stop | `promise` | Context and promise in the first line | Line 1 names the topic on all three channels; the viewer knows what they will get | Late context, or a vague promise |
| Stop | `gap` | A lean and a snapback | The hook leans one way and snaps back: one concrete question the viewer now needs answered | Nothing unresolved, or the answer is in the hook |
| Stop | `clarity` | Simple, short, easy to follow | Simple words, short sentences, one thread; a new idea said twice; pictures that match the words | Jargon, a drifting thread, pictures that do not match |
| Stop | `proof` | Proof early | A claim followed at once by proof the brief gives | A bold claim with no proof, or invented proof |
| Hold | `escalation` | Each beat raises the stakes or pays a reward | A but-and-therefore chain; the last item is the best | A flat list; the best item first; and-then-and-then |
| Hold | `density` | Value per second | No dead air, no throat-clearing, every line works | Preamble, repetition, filler |
| Hold | `specificity` | Concrete over abstract | Named situations, real numbers from the brief, sensory detail, a picture for every line | Categories, generalities, adjectives doing the work |
| Hold | `novelty` | A new element in a familiar container | One surprising angle, subject or form inside a format the viewer can read at once | Seen it before, or too strange to follow |
| Hold | `emotion` | A felt peak, high arousal where the niche allows | A clear emotional peak (awe, amusement, surprise, tension) near the payoff | Flat, informational, or sad without purpose |
| Payoff | `payoff` | The payoff beats the promise | It delivers more than promised, at the right moment | Late, small, or a different thing from the promise |
| Payoff | `rewatch` | A reason to watch again | A loop seam, a twist that recontextualises, a detail to catch | Ends on an outro; nothing to go back for |
| Spread | `send` | A reason to send it to someone | Identity, relationship or utility: "this is so you" | Nobody to send it to |
| Spread | `save_comment` | A reason to save or to say something | Lasting utility to come back to, or a genuine opinion split | No utility; or a comment request that is bait |

### 3.3 How a critic scores

LLM critics are biased: they prefer their own text and its family's (self-preference, `sourced`), longer answers (verbosity, `sourced`)
and the first or second option shown (position, `sourced`). From text alone they pick headline A/B winners at little better than chance
(LOLA, 17,681 Upworthy tests, `sourced`). Rules that follow:

1. **Evidence or zero.** Every score cites the beat or the moment it is about. A score with no evidence is recorded as 0.
2. **Compare, do not rate.** Prefer pairwise choices (A or B, with a reason) over absolute scores. Run each pair twice with the order
   swapped; a choice that flips with the order is a tie.
3. **A different family judges.** The critic is a model family other than the writer's when one is available.
4. **The critic finds failures; the audience decides winners.** A critic is trusted to find known failure modes (the checks in sections 4
   to 10). It is not trusted to predict a hit until its calibration report against real outcomes says so (section 13).
5. **Score the render, not only the script.** Multimodal models that see the video and hear the audio predicted short-video engagement at
   a rank correlation of about 0.71 on 120,651 Snapchat Spotlight videos, and models with audio did better (ICCV 2025 VQualA, `sourced`).
   The final critic watches the video with sound.

## 4. The hook system

### 4.1 Anatomy of a hook

A hook is not a sentence. It is the first one to three seconds on three channels at once, and each channel must work alone:

| Channel | Job | Rule |
| --- | --- | --- |
| **Picture** | Stop the eye | Motion or change in the first 0.5 s. A face, a hand doing something, an object out of place, or the result itself. Never a logo or title card. |
| **Text on screen** | Name the promise in sound-off viewing | At most about 7 words, large, in the safe area, readable in one glance. It frames the question; it does not repeat the voice word for word. |
| **Sound** | Pull in the ear | The first spoken words carry the stakes or the twist. Or a sound that demands attention (a snap, a pour, a gasp). Never "hey guys", "so", "in this video". |

The three channels say one thing in three ways: the picture proves it is real, the text names the question, the voice raises the stakes.
`practice`

### 4.2 The hook-payoff contract

Every hook makes a promise, and the payoff must keep it. Over-promise and the viewer completes the video feeling cheated: no send, angry
comments, lower trust in the account. Under-promise and nobody stops. The best hooks promise something specific and deliver more than that.
The direction report records each hook's promise and the beat that pays it; a promise with no paying beat is refused. `hypothesis`

### 4.3 Hook families

The codex holds 27 hook families (`HOOK_FAMILIES`), each with its mechanism, the niches it suits, its failure modes, the payoff it owes and
the Angle Bible entry it maps to where one exists. In short:

| Family | Mechanism | Owes the viewer |
| --- | --- | --- |
| `result_first` | Show the finished result first; the viewer stays to learn how | The method, with one surprise in it |
| `in_medias_res` | Start in the middle of the action; the viewer needs the context | The context, and how it ends |
| `contrarian` | Contradict what the viewer believes; a belief under threat is hard to ignore | A reason that changes their mind |
| `oddly_specific` | A strangely precise number or detail signals a real story | The story behind the number |
| `stakes_clock` | A goal with a deadline or a cost | The outcome, win or lose |
| `impossible_image` | A picture that should not exist; surprise pulls the gaze | The explanation, or the reveal that it is real |
| `identity_callout` | Name the viewer's group or situation; relevance is instant | Something only that group gets |
| `pov_relatable` | Put the viewer inside a moment they know | The beat that makes them laugh or feel seen |
| `confession` | Admit something; vulnerability opens a gap and builds trust | The honest truth, with its cost |
| `myth_bust` | Name a common belief and promise to break it | Evidence the viewer can check |
| `mistake` | "You're doing X wrong", the loss frame | The fix, shown, simple to copy |
| `before_after` | Show the gap between two states | How the gap was crossed |
| `question_gap` | Ask the exact question the viewer has | The answer, and one thing they did not expect |
| `ranking` | Order items; the viewer needs to see where theirs lands and what is first | A top item that earns its place |
| `versus` | Two options meet; the viewer picks a side | A winner, with a reason |
| `process_satisfaction` | A satisfying process starts at once; the eye stays for the finish | The finish, clean and complete |
| `unfinished_action` | Start an action and cut before it completes | The completion, later in the video |
| `mystery_object` | Hold up something unexplained | What it is and why it matters |
| `story_cliff` | Open on the most dramatic line of a story | The story, told fast, with the line paid off |
| `genre_flip` | Begin as one kind of video and turn into another | The turn, and why it was worth it |
| `challenge_test` | "I tested X so you don't have to" | The result, with what was surprising |
| `insider_reveal` | How it works behind the curtain | Something true the viewer could not see before |
| `fortune_teller` | A prediction that something will change how the viewer works | The change, specific enough to act on today |
| `proven_winner` | A result already achieved, checkable against the video | The exact thing that produced it, shown |
| `connector` | Two unrelated things linked; only the link closes the gap | The link, and why it matters |
| `desire_outcome` | An outcome the viewer secretly wants, tied to a relatable character | A non-obvious path to it |
| `pattern_interrupt` | A picture that does not belong, with a matching sound, in one or two seconds | A fast turn into the topic |

Rules for every hook (`HOOK_RULES` in the codex):

1. The hook is the first beat. No intro, no greeting, no logo, no channel name before it. `sourced` (TikTok: skip long intros and logo
   animations)
2. The promise is clear by 3 s and the hook ends by 6 s. `sourced` (TikTok guidance), initial values.
3. The hook does not answer its own question. `hypothesis`
4. The hook is specific: a number, a named situation, a visible object. "This changed everything" is not a hook. `practice`
5. The hook is true. Every promise in it is kept by a beat in the video. `hypothesis`, trust floor.
6. A new hook for every video: the brand's recent hooks are checked for repeats (content-factory `hook-history`). `hypothesis`

### 4.4 The triple hook and the text hook (codex 2)

From one creator's 274 posts (`practice`; see `LESSONS_CROSSWALK.md`, lessons 1 to 18):

1. **Context first.** Line 1 names the topic on picture, text and voice. Context that arrives even at the end of the first sentence raises
   the skip rate. Check `context_first`.
2. **Lean, then snap back.** Pull the viewer one way (a stat or proof, a pain, a benefit, a shock), then yank them the other way with a
   contrarian turn. Keep the first two sentences to 15 words. Check `opening_overload`.
3. **The text hook is read first.** Write it first: a subject plus a pain, a desire or a state change, specific, with power words
   (subject, action, state change, and above all contrast), no filler words, no punctuation but parentheses and quotes, at most two lines,
   placed about a third down, never over eyes or mouth. Check `text_hook_style`.
4. **Prove it at once.** A bold claim gets a trust anchor in line 2 or the lock-in: a direct result, the effort spent, a credible source,
   an association, strongest first. In Meridian the anchor must come from the brief; with none, the script makes no claim that needs one.
   Check `trust_anchor`.
5. **Declarative, not if-then.** "Do Y to get X." Check `if_then_hook`.
6. **Stun the eye.** An overlay, a pattern interrupt, subject motion, an effect, or a picture nobody else would choose; an interrupt needs a
   matching sound and lasts one or two seconds. Check `hook_sound`.

## 5. Retention architecture: designing the middle

The middle is where most videos die, slowly. The retention curve slopes down a little with every beat that does not pay, and nobody
notices until the payoff plays to a third of the audience.

### 5.1 But, therefore

Beats joined by "and then" are a list. Beats joined by "but" or "therefore" are a story: each beat is caused by the one before or
complicates it (Parker and Stone's rule for story structure, `practice`). The scriptwriter labels each beat's link to the one before: `but`,
`therefore`, or `and`. Two `and` links in a row are a warning.

### 5.2 Escalation

Order the material so the stakes rise. In a list, the best item is last and the second best first. In a story, each setback is bigger than
the one before. In a tutorial, the most surprising step is near the end. The MrBeast production memo treats each time block of a video as
having its own job, and treats the opening as where the promise of the thumbnail is met (`practice`, leaked memo).

### 5.3 Re-hooks

A long beat is an exit. Before the viewer can decide to leave, give them a new reason to stay: a new question, a reveal, a turn, a visual
change. Initial rule: no stretch longer than 7 s without a story or visual change (`hypothesis`, from the October 2026 research note), and
a re-hook by about the midpoint of a video over 20 s. The engine already measures interrupt intervals and punch-ins from the edit.

### 5.4 Open loops, nested

Open a question early and close it late. Open a second, smaller question inside it and close that one first, so the viewer gets a reward
without losing the reason to stay. Each open loop is recorded with the beat that opens it and the beat that closes it; a loop that never
closes is refused (it reads as bait).

**A correction to an old claim.** The Angle Bible attributes open loops to the Zeigarnik effect, that unfinished tasks are remembered
better. A 2025 meta-analysis found no memory advantage for unfinished tasks, though it did find a general tendency to resume them (the
Ovsiankina effect) (`sourced`). Open loops work through curiosity and the urge to complete, not through memory. `contested` for Zeigarnik.

### 5.5 Density

Write fewer words that each do more. Cut the first sentence of every draft; it is almost always throat-clearing. Speak at a natural, quick
pace (about 150 to 180 words per minute in the Angle Bible's cadence entry, `practice`) with real pauses at turns. On-screen text reads at
5 to 10 words per second (TikTok creative guidance, page not opened, `sourced` weakly). A video is as long as its payoff needs and no
longer. `practice`

### 5.6 Format archetypes

The codex holds a beat skeleton for each common format (`FORMAT_ARCHETYPES`), as fractions of the duration: where the hook, the promise,
the re-hooks, the peak and the end sit. The engine's grammar measured from a reference overrides a skeleton when a reference exists, because
measurement beats a template (Bible principle: copy genes). Codex 2 has 22: listicle (the best two points first), S-tier ranking (the top
held back), three levels, story, hero's journey, personal epiphany, tutorial, transformation, myth versus fact, challenge or test, scenario,
case study, live breakdown, POV skit, through my eyes, explainer with a visual metaphor, whiteboard reveal, reaction or commentary, A versus
B, show the factory, extremes, and satisfying process. Each sits on the format pyramid (facts, explanation, application, story): as a niche
saturates, facts and lists stop working first, and application and one-of-one stories hold up longest.

### 5.7 The core template, the lock-in and the hourglass (codex 2)

1. **Template.** Hook, lock-in, body block, rehook, body block, an optional rehook and block, the payoff, and a call to action only when
   the job is to convert.
2. **Lock-in.** The two or three sentences after the hook: tease the proof or the transformation, add a clarifying contrast, name a method
   (a magic box), answer the top objection, or double down and twist the pain. Check `lock_in`.
3. **The hourglass.** Short-form attention runs about 25 seconds. Rehook within 15 seconds, and turn into a new part at least every 25
   seconds with a turn that opens a new loop. Checks `double_hook`, `peak_gap`.
4. **Beat the expectation.** At every beat, would most viewers be surprised by what comes next? An equal or worse moment loses them. The
   swipe test scores each window's expectation.
5. **A villain.** A video that teaches attacks the old way, a false belief, or the frustration they cause. Check `villain`.
6. **Two ahas, early.** Two non-obvious lightbulb moments in the first part. Check `double_aha`.

## 6. The rewatch and the loop

1. **Design the end first.** The last line and the last frame are written before the middle. `practice`
2. **The loop seam.** The last sentence can run into the first ("...and that is why" / "I stopped buying these."), or the last frame matches
   the first. The engine measures `loopDistance` between the first and last frames already. `practice`
3. **The recontextualising twist.** The payoff changes what the opening meant, so the opening is worth seeing again. `hypothesis`
4. **No outro.** No "thanks for watching", no "follow for more", no logo end card in an organic video. The end is a punch or a seam.
   `practice`
5. **Peak, then end.** People judge an experience by its peak and its end (the peak-end rule, Fredrickson and Kahneman 1993, `sourced`).
   End on or just after the peak, never on a decline.

## 7. Spread: sends, saves and comments

The questions to answer before writing, from Berger's STEPPS (social currency, triggers, emotion, public, practical value, stories,
`sourced` as a framework):

- **Who is this sent to, and what does sending it say?** If there is no answer, there is no send. The codex's `SHARE_TRIGGERS` lists the
  reasons people send: identity ("this is me"), relationship ("this is us"), utility ("you need this"), status ("I found it first"),
  emotion ("you have to see this"), and conversation ("what do you think?").
- **Why would someone save it?** Lasting practical value: a method, a list, a recipe, a reference to return to. Saves turn into follows:
  signal the outcome, show tactical detail and the exact inputs on screen, give more than one pass can hold (codex `SAVE_DEVICES`).
- **Shares and likes are different.** Likes come from agreement; sends come from the surprising, the contrarian and the emotional, and
  reach new viewers.
- **A call to action, only to convert.** One CTA aligned to the topic, framed as a favour, for a resource the brief names. A keyword for a
  real resource is not bait; "comment YES" is. Check `cta_alignment`.
- **What would someone say?** A genuine opinion split, a recognisable experience, a question the video leaves open honestly. Never
  "comment YES if you agree": engagement bait can limit distribution (`sourced`).

## 8. Emotion

1. **Pick one feeling.** One dominant emotion per video, chosen before writing. `practice`
2. **Prefer high arousal.** Awe, amusement, surprise, tension and righteous anger spread; sadness on its own does not (Berger and Milkman
   2012, `sourced`). Anger is high-reach and high-risk: it is allowed only against a problem, never against a person or a group, and never
   for a brand without the brand's policy allowing it.
3. **Humour is a benign violation.** Something is wrong, and it is also fine: a norm broken in a safe way (McGraw and Warren 2010,
   `sourced`). Humour comes from a specific truth the audience recognises, not from a joke template. LLM jokes repeat: over 90% of 1,008
   ChatGPT jokes were 25 jokes (Jentzsch and Kersting, `sourced`). The agent never uses a stock joke.
4. **Narrative transportation.** A viewer absorbed in a story argues less with it (Green and Brock 2000, `sourced`). A story with a person,
   a want and an obstacle persuades more than a list of benefits.

## 9. Script craft for agents

These are the codex's `SCRIPT_RULES`. The checks in `slop.ts` and `attention.ts` measure what can be measured.

1. **Write for the ear.** Short sentences. One idea per sentence. Words people say aloud, in the order they say them.
2. **Write the timeline, not the paragraph.** Each beat has a role, a duration, its voice line, its on-screen text and its picture. The
   word budget of a beat is its duration times the voice's pace.
3. **Start late, end early.** Cut the setup; start at the first interesting moment. End on the payoff.
4. **Specific over general.** A name, a number from the brief, a place, an object, a time. Never invent one. When the brief gives no
   specific, use a concrete picture instead of an invented fact.
5. **One reader.** Talk to one person ("you"), in their words. The brief's sources (reviews, comments, forum posts) are where their words
   are found.
6. **Every line has a picture.** If a line cannot be shown, it is probably abstract. Rewrite it until it can.
7. **No AI register.** The words and patterns in the codex's slop lexicon are refused or warned (section 11, W4).
8. **Contrast.** Before and after, expected and actual, them and us. Contrast is how a viewer sees a difference fast.
9. **Read it aloud at speed.** The critic estimates speech time at the voice's pace and flags lines over the beat's budget.
10. **Zig-zag the rhythm.** Mix short, medium and long sentences with short punchy resets; models do not check rhythm by themselves.
    Check `rhythm`.
11. **Simple and short.** Third-grade words, punchy sentences. Check `reading_level`.
12. **Say a new idea twice.** Precisely, then plainly; anchor it to something familiar; name your best idea so two words replace a
    sentence.
13. **Small effort, big reward.** One setting, two small things; a big result.

## 10. Visual, photo and sound direction

### 10.1 Picture

1. **Frame 0 is the thumbnail of the feed.** It is chosen, not inherited. Motion, a face, contrast, or the result. `practice`
2. **Change on the beat.** A cut, a punch-in, or a change of angle at each turn of the script; the engine's edit grammar carries the
   measured cadence of the reference. `practice`
3. **Illustrate the words, literally or laterally.** The picture shows what the voice says, or adds what the voice does not. Never
   decoration: the pre-render gate already scores "decorative visuals" as slideshow risk.
4. **Texture over gloss.** Generated pictures drift towards one look: symmetrical, over-saturated, cinematic-generic, waxy skin. Ask for
   real light, real wear, a handheld feel where the format is creator-led, and real product imagery always (Bible L8). The take critic's
   slop rubric checks the rest.
5. **Text is drawn by code.** No text, label, price or logo in a generation prompt (Bible rule).
6. **Safe zones.** Key content stays out of the lower fifth and the right twelfth (the final critic's rule).
7. **Move with intention.** A talking head changes position or setting between beats; a series keeps one look so it is recognised.

### 10.2 Photo and carousel

1. Slide 1 is the hook: one claim or one image that demands the next slide.
2. Each slide ends with a reason to swipe: a half-finished thought, a numbered promise, a reveal on the next slide.
3. The last slide is the payoff, and the save reason.

### 10.3 Sound

1. **The voice performs.** Vary the pace; pause before the reveal; stress the one word that matters (the script's `emphasis`). Speak about
   20% more powerfully than feels natural: recordings sound thinner than the voice in your head.
2. **Music follows the energy curve.** It rises into the peak and drops under the key line.
3. **Sound marks the cut.** A hit, a whoosh or a silence at a turn of the story is a pattern interrupt for the ear.
4. **Silence is a tool.** A half-second of silence before the payoff is louder than any effect.
5. **Sound-off works too.** On-screen text carries the story for a viewer who never turns the sound on.
6. **Trending audio** is used only with a licence that covers the use (Bible 20.2: music source is an open question for the owner).

## 11. Where AI fails, and the countermeasure for each

This is the part most pipelines skip. A model writes the median of what it has read, approved by raters who prefer the familiar. The
median is what people scroll past. The codex holds each weak spot (`AI_WEAK_SPOTS`) with its symptom, its countermeasure, and the check
that catches it.

| Id | Weak spot | Evidence | Countermeasure |
| --- | --- | --- | --- |
| W1 | **Homogeneity.** One model repeats itself, and different models converge on the same ideas. | Artificial Hivemind: high similarity across 70+ models on open-ended prompts (NeurIPS 2025, `sourced`). AI-assisted stories are more alike than human ones (Doshi and Hauser 2024, `sourced`). | Diverge before converging (section 12): many candidates, more than one model family, verbalized sampling, forced combinations, and a similarity check against each other and the brand's history. |
| W2 | **Typicality bias.** Alignment rewards the familiar answer, so the first answer is the safe one. | Preference data favours typical text; asking for a distribution of answers with probabilities raised creative diversity 1.6 to 2.1 times (Verbalized Sampling, 2025, `sourced`, authors' own result). | Ban the obvious: the agent lists the ten most obvious ideas first, and those are excluded. Ask for low-probability candidates explicitly. |
| W3 | **Abstraction.** Talks in categories ("boost your productivity") instead of moments. | `practice` | Specificity rules (section 9); the specificity measure in `attention.ts`; every line needs a picture. |
| W4 | **AI register.** Words and patterns readers now recognise as machine-written: "delve", "unlock", "game-changer", "in today's fast-paced world", tricolons, "it's not X, it's Y". | Excess vocabulary after ChatGPT in 14 million abstracts (Kobak et al., `sourced`). | The slop lexicon in `slop.ts`: phrases refused, patterns warned, with the line they occur on. |
| W5 | **Helpfulness.** Explains too much, resolves tension at once, answers the hook's question in the hook. | `practice` | Withholding rules: the hook does not answer itself; the payoff sits in the last third; the attention check flags an early answer. |
| W6 | **No sense of time.** Writes paragraphs, not beats; cannot feel 1.5 seconds. | `hypothesis` | Timeline-first writing with a word budget per beat; measured speech time; the Swipe Test walks the video in 1 to 2 s windows. |
| W7 | **Weak self-judgement.** Prefers its own text; sways with order and length; picks winners at near chance from text. | `sourced` (section 3.3) | Pairwise, order-swapped, cross-family judging; calibration against outcomes; the critic finds failures, the audience picks winners. |
| W8 | **Accepts a weak brief.** Writes the brief as given, even when the angle is dull. | `hypothesis` | A brief challenge step: the strategist names what would make the brief's angle worth watching, and proposes a sharper one, inside the claims. |
| W9 | **Safe blandness.** Avoids edge, humour and strong opinion. | Comedians called LLM output bland and generic (2024 study, `sourced`, secondary). | Permission inside guardrails: benign violations, honest strong opinions the brand holds, humour from specific truths. The trust floor still applies. |
| W10 | **No live culture.** Knows nothing after its cutoff; invents trends. | `sourced` (model cutoffs) | Trends come only from Meridian's discovery data and the brief's sources, with dates. The agent never names a trend it was not given. |
| W11 | **Sees frames, not motion.** A vision model sent stills misses pacing, motion and sound. | Bible risk register; engagement prediction improves with audio (`sourced`). | The final attention critic is a native video-and-audio model; the engine's motion and loudness metrics go with every check. |
| W12 | **Invents facts.** Numbers, results, testimonials. | `sourced` (well documented) | The existing claims gate; specificity comes from the brief or the picture, never from the model; every number in a script is checked against the brief, its sources and the claims (`facts.ts`). |
| W13 | **Recites memorised viral lines.** Familiar hooks reappear word for word. | `practice`; joke repetition (`sourced`) | The reference copy check (six words), the hook history check, and the slop lexicon's stock hooks. |
| W14 | **The generated look.** Plastic skin, warped backgrounds, morphing objects, and one shared glossy aesthetic. | Bible 12.2 slop rubric | The take critic's rubric, art direction toward texture and imperfection, and real footage where it matters. |
| W15 | **No stakes.** Information without a want, an obstacle, or a cost. | `practice` | The direction brief requires stakes: who wants what, and what stands in the way. |
| W16 | **Flat rhythm.** Sentences of one length; the ear tunes out. | `practice` (lesson 31) | The zig-zag rule in every script prompt; check `rhythm`. |
| W17 | **Hedged, generic hooks.** If-then openings, info teases, claims with no proof. | `practice` | Declarative desire hooks, a trust anchor from the brief, the text-hook rules; checks `if_then_hook`, `text_hook_style`, `trust_anchor`, `lock_in`. |

## 12. The machine: how the agents work together

### 12.1 The flow

```
 Brief + brand + sources + discovery data
        |
  A. Intelligence      niche genome, audience language, reference genes, trends (dated), brand hook history
        |
  B. Brief challenge   what would make this worth watching? a sharper angle inside the claims
        |
  C. Divergence        30+ concept seeds: hook family x format x emotion x angle, 2+ model families,
        |              verbalized sampling, the obvious ideas banned
  D. Filter            claims, brand, budget, feasibility, originality (similarity to each other and to history)
        |
  E. Tournament        pairwise, order-swapped, cross-family viewer panel; Bradley-Terry ranking;
        |              diversity-preserving top 3
  F. Script            beat timeline: voice, on-screen text, picture, link (but/therefore), loops, emphasis
        |
  G. Swipe Test        second-by-second walk: what the viewer sees, the open question, the swipe risk;
        |              slop and attention checks; at most two revisions
  H. Direction         shot list, frame 0, sound plan, rewatch device, send trigger, hook variants
        |
  I. Production        Meridian's engine (plan, produce, edit, compose, render, gates)
        |
  J. Watch Test        a video-and-audio model watches the render: frame 0, pace, payoff, sound
        |
  K. Test and learn    hook variants on trial audiences; outcomes join the direction record; priors update
```

### 12.2 The roles

| Role | Decides | Never does |
| --- | --- | --- |
| **Strategist** | The audience, the one feeling, the angle, the challenge to the brief | Invent a claim or a trend |
| **Concept lab** | Many distinct seeds, each a hook family, a format, an angle and a payoff | Return the obvious first idea |
| **Viewer panel** | Which of two concepts or scripts the target viewer would stop for and send | Score in the absolute; see who wrote what |
| **Script director** | The beat timeline across voice, text and picture | Break a claim, a length or a copy rule |
| **Swipe tester** | Where in the timeline a viewer would leave, and why | Rewrite the script itself; it reports, the director revises |
| **Visual director** | Frame 0, the shot list, the art direction, the prompts | Put text in a generation prompt |
| **Watch tester** | Whether the rendered video does what the script promised | Judge claims or prices |

### 12.3 Choosing models: by capability, never by habit

Meridian chooses models by capability, with an explicit user choice and an Auto choice (AGENTS.md rule 5), from the live catalog (Bible
10.5). Leaderboards disagree and move every month: EQ-Bench and the Arena rank creative writers in close to opposite orders (August 2026
analysis, `sourced`, secondary). So the direction layer names needs, and a bake-off on Meridian's own gold set decides the model.

| Role | Need | Candidates to test (2026-11, verify in the live catalog) |
| --- | --- | --- |
| Strategist, concept lab | Strong creative and reasoning; at least two families for diversity | Claude Opus 5.5; a second family from the catalog (GPT-6.x, Gemini 4, Kimi K3, Qwen 3.8) |
| Script director | The best spoken-word short-form writer on Meridian's blind test | Bake-off; the current scriptwriter role runs on Opus |
| Viewer panel, swipe tester | A family other than the writer's; good at following a rubric | A Sonnet-class model of another family, or Claude when the writer is not Claude |
| Watch tester | Native video with audio, many frames per second | Gemini-class native video models lead documented long-video benchmarks (Video-MME, `sourced`, secondary) |
| Visual generation | Per shot: people, motion, product fidelity, spectacle | Through the engine's router and `model_chooser` (Bible 10); Wan 3.0, HappyHorse, Kling, Seedance and others as listed and priced |
| Voice | Expressive pace, pauses, emphasis | The engine's speech candidates (model brief); judged by the watch tester with audio |

### 12.4 The direction record

Every concept and script carries a direction record: its hook family and channels, its promise and the beat that pays it, its open loops,
its one feeling, its send trigger, its rewatch device, the checks it passed and the scores it earned, with the models and prompt versions
that produced it. This record is what the learning loop joins to outcomes (section 13). Without it, nothing can be learned.

## 13. Evaluation and learning

1. **Gold sets.** Pairs of videos from the same creator and niche, one an outlier and one at the creator's median (same creator, so the
   account is held constant). The critic's pairwise accuracy on these pairs is its calibration number. Target before the critic may
   rank: above 65% (`hypothesis`, initial).
2. **Human taste panel.** Blind pairwise choices by people from the target audience, recorded as gold labels with reasons (Bible 12.5).
3. **The real test.** Hook variants of one master on trial audiences (Instagram trial reels, `sourced`) or paid tests with a small budget
   the owner approves. Measured: chose-to-view, 3 s retention, average watch percentage, replays, sends per reach, saves.
4. **What the loop tunes.** The rubric weights, the hook family priors per niche and format, the windows in section 1.3, the re-hook
   interval, the critic's thresholds. Every tuned value has a floor, a ceiling and a nightly step limit (Bible 16.3).
5. **Adaptive testing beats prediction.** Use the model's preference as a prior, and let experiments allocate traffic (the LOLA result:
   LLMs plus adaptive experimentation beat either alone, `sourced`).

## 14. Niches and content types

### 14.1 The niche genome

Before writing for a niche, the strategist fills these from the brief, the brand brain, and discovery data. It never fills them from
assumption:

- **Who:** the viewer's identity, situation, and what they want to be seen as.
- **Their words:** phrases taken from comments, reviews, forums (the brief's sources), quoted as data.
- **Pain and desire:** what they are tired of; what they want and have not got.
- **The enemy:** the problem, the myth, or the status quo (never a person or group).
- **Saturation:** the formats and hooks the niche has seen too often (from discovery data).
- **Status games:** what earns respect in this group, and what earns ridicule.
- **Taboos:** what this audience or the brand will not accept.

### 14.2 Niche defaults

The codex holds starting defaults per niche family (`NICHE_PROFILES`): the dominant emotions, the hook families that tend to fit, the
proof devices, and the pitfalls. They are priors (`hypothesis`) for the learning loop to replace with the brand's own results.

## 15. What a direction agent outputs

For each video, one direction document:

1. **The concept, in one sentence**, and its topic, core argument and evidence, job, hook family, format, feeling, angle and novelty
   element.
2. **The hook on three channels:** frame 0, the on-screen text, the first spoken line. Its promise, and the beat that pays it.
3. **The beat timeline:** each beat's role, duration, voice line, on-screen text, picture, sound, link to the previous beat, emphasis
   words; and the declared lock-in, trust anchor, villain, ahas, rehooks and call to action.
4. **The open loops:** where each opens and where it closes.
5. **The end:** the payoff, the rewatch device, the send trigger, the save or comment reason.
6. **The sound plan:** voice performance notes, music energy, sound marks.
7. **The Swipe Test:** each window's risk and the reason, after revision.
8. **The checks:** the slop and attention findings, and the floors passed.
9. **Hook variants for testing:** two or three alternative first three seconds on the same body.
10. **The record:** models, prompt versions, codex version.

## 16. The short version, for every prompt

1. Stop the eye in the first second: motion, a face, the result, or a pattern interrupt with a matching sound. Never an intro.
2. Line 1 names the topic on picture, text and voice; then lean one way and snap back the other. Two sentences, 15 words at most.
3. Write the text hook first: a subject plus a pain, a desire or a state change, specific, with power words.
4. Prove a bold claim at once, with proof the brief gives; lock the viewer in with the next two or three sentences.
5. Rehook within 15 seconds, and turn into a new part at least every 25 seconds: but, therefore.
6. Fight a villain (the old way, a false belief), and land two non-obvious ahas early.
7. Simple words, zig-zag rhythm, every picture matching its words; say a new idea twice.
8. Pay more than you promised, at the peak; end on a punch or a seam. No outro.
9. One job per video: shares for reach, saves for follows, an aligned call to action to convert.
10. Never invent a fact, a proof, a trend or an endorsement. No bait, no stock hooks, no AI register.

## 17. What version 2 added

Codex `direction-codex@2` folds in 147 short-form lessons from one creator's 274 posts. They are `practice` (his own data), so the
learning loop tests them on the brand's results before any becomes a measured rule. Version 2 adds:

- Five hook families, the triple hook, text-hook rules, power words, the four S's, visual-hook types and trust anchors (section 4.4).
- The core template, the lock-in zone, the hourglass rehook, expectations versus reality, villains and the double aha (section 5.7).
- Ten formats and the format pyramid (section 5.6).
- Two rubric dimensions, `clarity` and `proof`.
- Save and comment devices, and the native call to action (section 7).
- Zig-zag rhythm, reading level, the double tap and small-effort framing (section 9).
- Fourteen checks: `context_first`, `opening_overload`, `if_then_hook`, `double_hook`, `peak_gap`, `rhythm`, `reading_level`,
  `text_hook_style`, `lock_in`, `trust_anchor`, `villain`, `double_aha`, `hook_sound`, `cta_alignment`.
- The video's job and the content planner (section 18).

Two lessons were not adopted, because they break a Meridian rule: opening on another creator's viral clip (copy genes, never content) and
secret brand-owned "fan" accounts (they hide who is speaking). Three were adapted: proof and trust anchors only from the brief, reposting
only the brand's own winners, and keyword calls to action only for a real resource the brief names.

## 18. What each video is for

1. **One job per video.** Reach (shares to new viewers: a broad audience, a non-obvious angle), follow (saves and binges: tactical
   density, a series), or convert (a narrow buyer's pain, a desire hook, proof, an aligned call to action). `VIDEO_JOBS`.
2. **The virality stack.** Topic commonness, angle obviousness and audience breadth: the non-obvious angle is in every winner; go broad to
   reach, narrow to convert. Too much broad reach too early fills the audience with people who will never buy (the viral trap).
3. **The idea is the cake.** A relevant, painful topic with a large audience, from data; a non-obvious, contrarian angle, from creativity;
   a format transposed from where it already won. Hook, edit and style are icing.
4. **The planner** (`plan.ts`) turns that into a calendar: subtopics x formats x layouts (the 6x5, 532 and 331 grids, and the 321 week),
   jobs per content game and a 3-2-2 bullseye mix, the brand's outliers (5x its median) remixed one brick at a time and reposted after four
   months, and the view ceiling that says which lever to pull next.
