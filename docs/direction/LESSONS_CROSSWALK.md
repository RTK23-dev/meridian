# The short-form lessons, crosswalked into Meridian

Version 1, 2026-11-04. The source is a study of the creator Kallaway's posts (@kallawaymarketing and related accounts): 274 posts from
October 2023 to November 2026, with captions, transcripts and slide text, distilled into 147 lessons in nine themes. This document says,
for every lesson, where it now lives in Meridian's direction system (`direction-codex@2`), or why it does not.

**Evidence.** The lessons are one creator's practice and his own account data ("a 14M vs 40K view gap", "8 to 31 leads per 1,000 views").
None was checked against another source here. Every rule taken from them is labelled `practice` in the codex, and the learning loop
(`RND_PROGRAM.md`) tests them on the brand's own results before any becomes a measured rule.

**Status words.**

| Status | Meaning |
| --- | --- |
| Encoded | A codex rule or list that reaches the prompts, and where it can be measured, a check |
| Checked | Encoded, and a check in `attention.ts`, `craft.ts`, `slop.ts` or `facts.ts` tests it on every script |
| Planner | In `plan.ts`: what each video in a run is for |
| Learning | Needs the brand's own results: a study in `RND_PROGRAM.md` or a step of the learning loop |
| Adapted | Adopted with a change, so it fits Meridian's rules; the change is stated |
| Not adopted | Conflicts with a Meridian rule; the reason is stated |
| Outside direction | True, but about the business, the team or another product area, not the making of a video |

Paths: `codex` is `src/lib/meridian/direction/codex.ts`; checks are named by their check id; prompts by their id (`concept_lab@2`,
`viewer_panel@2`, `script_director@2`, `swipe_test@2`).

## 1. Hooks

| # | Lesson | Where it lives | Status |
| --- | --- | --- | --- |
| 1 | Triple hook: context, lean, snapback | `TRIPLE_HOOK`, rules `context_first` and `triple_hook`; checks `context_first`, `opening_overload`; both writer prompts | Checked |
| 2 | Hook alignment; text over spoken over visual | `HOOK_CHANNEL_PRIORITY`, rule `hook_aligned`; `viewer_panel@2` (most read the text first); check `text_echoes_voice` | Checked |
| 3 | The title text is read first | Rules `hook_aligned`, `text_hook`; writers write the text hook first | Encoded |
| 4 | Text-hook writing and design | Rules `text_hook`, `text_hook_place`; checks `text_hook_style`, `hook_text_length` | Checked |
| 5 | The hook power words | `POWER_WORD_ROLES`, rule `text_hook`; a power-word bank per niche is study R11 | Encoded, Learning |
| 6 | The four S's | `FOUR_S`, rule `four_s`, rubric `clarity`; check `reading_level` | Checked |
| 7 | Hook mistake: delayed context | Rule `context_first`; check `context_first` | Checked |
| 8 | Overloading, the missing proof loop, no double hook | Rules `opening_words`, `proof_loop`, `double_hook`; checks `opening_overload`, `trust_anchor`, `double_hook` | Checked |
| 9 | The trust anchor in line 2 | `TRUST_ANCHOR_TYPES` (strongest first); script field `trustAnchor`; check `trust_anchor`. Adapted: the proof must come from the brief; with none, the anchor is null and the script makes no claim that needs one | Checked, Adapted |
| 10 | The desire hook | Hook family `desire_outcome`; rule `desire_not_tips` | Encoded |
| 11 | Six hook formats | Hook families `fortune_teller`, `contrarian`, `insider_reveal`, `proven_winner`, `impossible_image` (eye magnet), `connector` | Encoded |
| 12 | The visual stun gun | `VISUAL_HOOK_TYPES`, rule `stun_gun`; rubric `stop_frame` | Encoded |
| 13 | Pattern-interrupt hooks with matching audio | Hook family `pattern_interrupt`; rules `interrupt_sound`, `interrupt_audio`; beat field `sound`; check `hook_sound` | Checked |
| 14 | Framebreaker hooks and hook mining | Adapted: mine the psychology of proven hooks (the genome role and hook families), never their footage; per-niche priors are study R9 | Adapted, Learning |
| 15 | Clip-stitch hooks | Opening on another creator's viral clip puts their footage in our video (Bible principle 4: copy genes, never content), and Instagram now cuts reach for reposted content. The reaction format recreates or describes the moment instead | Not adopted |
| 16 | Psychology attention triggers | Hook families `oddly_specific`, `desire_outcome`, `proven_winner`; rule `specific`. Adapted: a named person or a result appears only when the brief gives it | Adapted |
| 17 | Power words, and a power-word bank | `POWER_WORD_ROLES`; the bank, mined from the niche's top transcripts by performance and position, is study R11 | Encoded, Learning |
| 18 | Retention hunting | Retention spikes on the brand's posts become future hooks: study R13; skip-rate bands are recorded as one creator's benchmarks | Learning |

## 2. Script structure, storytelling and retention

| # | Lesson | Where it lives | Status |
| --- | --- | --- | --- |
| 19 | The core short-form template | `CORE_TEMPLATE`; every format skeleton; `script_director@2` rule 5 | Encoded |
| 20 | The listicle template | Format `listicle` (best two points first) | Encoded |
| 21 | The lock-in zone | `LOCK_IN_APPROACHES`; script field `lockIn`; check `lock_in`; rule `lock_in` | Checked |
| 22 | The hourglass and the mid-flip rehook | Rule `hourglass`; window `maxPeakGapMs` (25 s); script field `rehooks`; check `peak_gap` | Checked |
| 23 | The modern story arc | Format `story` (start at 70 of 100, a peak every 20 to 30 s); rule `hourglass` | Encoded |
| 24 | The triple loop | Checks `double_hook` (by 15 s) and `peak_gap` (the rehook loop); loops declared on every script | Checked |
| 25 | The dopamine addiction loop | `DOPAMINE_LOOP`; rules `stakes`, `anticipation`, `beat_expectations` | Encoded |
| 26 | Anticipation loading | Rule `anticipation` (two or three loops a video) | Encoded |
| 27 | Expectations versus reality | Rule `beat_expectations`; `swipe_test@2` scores each window's `expectation`; `viewer_panel@2` rule 1 | Encoded |
| 28 | The shock score | Rule `beat_expectations` (of 100 viewers, how many would be surprised?) | Encoded |
| 29 | But, therefore | Rule `but_therefore`; check `and_chain` (codex 1) | Checked |
| 30 | The villain effect | `VILLAIN_TYPES`; script field `villain`; check `villain` for facts and explanation formats | Checked |
| 31 | The zig-zag rhythm test | Rule `zig_zag`; check `rhythm`; weak spot W16 | Checked |
| 32 | Storyflow | Rule `storyflow`; the swipe test's comprehension leak | Encoded |
| 33 | The double tap | Rule `double_tap`; rubric `clarity` | Encoded |
| 34 | Anchor terms | Rule `anchor_terms` | Encoded |
| 35 | Comprehension maxxing | Rule `match_words` (pictures match words; broad, then narrow); rubric `clarity`; check `picture_missing` | Encoded |
| 36 | Embedded truths | Rule `declarative`; check `if_then_hook`; weak spot W17 | Checked |
| 37 | The specificity effect | Rule `specific` (figures, a time frame, named concepts); checks `specificity`, `unsourced_number` | Checked |
| 38 | Small effort, big reward | Rule `small_effort`; `concept_lab@2` rule 5 | Encoded |
| 39 | The lawyer method | Rule `lawyer`; concept fields `coreArgument`, `evidence` | Encoded |
| 40 | Relevant, novel, interesting | Rule `relevant_novel_interesting`; `concept_lab@2` rule 5 | Encoded |
| 41 | Story funnel blockers | `FUNNEL_BLOCKERS`; `swipe_test@2` names the biggest; a script ships only with none | Encoded |
| 42 | The illusion of novelty | `concept_lab@2` rule 5 (an old idea in a new frame); rubric `novelty` | Encoded |
| 43 | The story lens | The concept lab lists the obvious angles first and bans them (codex 1), on cards that force new lenses | Encoded |
| 44 | The story pyramid | Rule `idea_first`; the boring-business formats (#53) | Encoded |
| 45 | The story ladder | `STORY_LADDER` (write at the architect level or above) | Encoded |
| 46 | The dopamine ladder | `DOPAMINE_LADDER`; rubric `stop_frame`, `escalation`, `payoff` | Encoded |
| 47 | The double aha | Script field `ahas`; check `double_aha`; rule `double_aha` | Checked |
| 48 | Viral storytelling and series | Formats plus the planner's grids; rule `series_look`; job `follow` | Encoded, Planner |
| 49 | Delivery: 20% more powerful | Rule `voice_power` (the voice role's direction) | Encoded |

## 3. Formats and visuals

| # | Lesson | Where it lives | Status |
| --- | --- | --- | --- |
| 50 | The format pyramid and saturation | `FORMAT_LEVELS`; each format's `level`; rule `format_pyramid` | Encoded |
| 51 | Application over eduslop | Rule `format_pyramid`; formats `scenario`, `case_study`, `live_breakdown` | Encoded |
| 52 | Six storytelling formats | `test_experiment` (challenges), `scenario`, `hero_journey`, `live_breakdown`, `epiphany`; social shows are series (planner) | Encoded |
| 53 | Six formats for boring businesses | `case_study`, `live_breakdown`, `scenario`, `behind_the_scenes` (show the factory), `extremes`, `s_tier_ranking` | Encoded |
| 54 | S-tier ranking videos | Format `s_tier_ranking` (progressive reveal; a beloved item low) | Encoded |
| 55 | Three-levels videos | Format `three_levels` | Encoded |
| 56 | A versus B videos | Format `comparison` (speed to shock; always explain why) | Encoded |
| 57 | Better talking-head videos | Rules `text_hook`, `intentional_motion`; the direction run is the plan before recording | Encoded |
| 58 | Whiteboard explainers | Format `whiteboard_reveal` | Encoded |
| 59 | Through-my-eyes POV, and transposition | Format `pov_through_my_eyes`; rule `dct` (transpose formats across niches) | Encoded |
| 60 | Series and bingeability | Job `follow`; the planner keeps format and layout steady; hard and soft series are a planning choice; episode linking is a publishing feature | Planner |
| 61 | Visual sameness is recognition | Rule `series_look` | Encoded |
| 62 | Video length: avoid the mushy middle | One account's 90-day audit, so not a rule: study R15 measures length buckets on the brand's own posts | Learning |
| 63 | The high-effort era | Rule `high_effort` | Encoded |

## 4. Ideas, topics and originality

| # | Lesson | Where it lives | Status |
| --- | --- | --- | --- |
| 64 | Ideas are 95/5: the cake and the icing | Rule `idea_first`; concept fields `topic`, `coreArgument` | Encoded |
| 65 | The DCT method | Rule `dct`; topics from discovery data, angles from the concept lab, formats transposed | Encoded |
| 66 | The virality stack | `VIRALITY_STACK`; concept fields `job`, `audience`; rule `virality_stack`; the planner's audience per job | Encoded, Planner |
| 67 | View ceilings | `VIEW_CEILINGS`; `viewCeiling` in the planner | Planner |
| 68 | The four horsemen | Rules `lawyer`, `specific`, `four_s`, `proof_loop`, `term_branding` (sentence compression) | Encoded |
| 69 | The one-degree rule | `ONE_DEGREE_DESIRES`; rule `desire_not_tips`; `concept_lab@2` rule 5 | Encoded |
| 70 | Expand the audience for views | The reach job's direction (broad terms, broad outcome) | Encoded |
| 71 | Broad to narrow | Rule `broad_to_narrow` | Encoded |
| 72 | Originality density and wrapping | The originality floor (codex 1); rubric `novelty`; `concept_lab@2` rule 5 | Encoded |
| 73 | The six idea pipes | Own winners: `outliers`, `legoVariations`; competitor outliers: discovery data; long-form, Reddit, client talk: the brief's sources; scroll reactions and originals: the concept lab | Planner, Encoded |
| 74 | Conversational ideation | A reference plus "what did its maker miss?" is the concept lab's core argument; a dedicated prompt is proposed in `INTEGRATION.md` | Encoded |
| 75 | The Lego brick method | `legoVariations` (one brick at a time first); rule `winners_first` | Planner |
| 76 | Remix outliers with a perspective | `outliers`, rule `winners_first`, concept field `coreArgument` (the perspective); copying without one is refused by the copy check | Planner |
| 77 | Repost winners | `repostCandidates`: the brand's own 5x outliers after four months, changed a little. Adapted: never another creator's video, and no re-exporting to evade copyright detection | Planner, Adapted |

## 5. Strategy, growth and the algorithm

| # | Lesson | Where it lives | Status |
| --- | --- | --- | --- |
| 78 | How the algorithm samples | Framework section 2 (what the platforms read); the test-group sizes are one creator's description | Encoded |
| 79 | Connected and unconnected reach | Rule `send_reason` (shares from surprise, likes from agreement); `viewer_panel@2` rule 2 | Encoded |
| 80 | Shares get views, saves get followers | `SAVE_DEVICES`; rule `save_reason`; the follow job's direction | Encoded |
| 81 | Three ways to earn comments | `COMMENT_DEVICES`; rule `comment_reason`. Adapted: an extreme claim is plain opinion inside the brand's policy and the claims gate | Adapted |
| 82 | Quality versus quantity in three phases | `qualityPhase` | Planner |
| 83 | Volume and iteration | The planner's grids and the learning loop; the originality floor keeps volume from becoming the "mass-produced, repetitive" content YouTube does not pay | Planner |
| 84 | Speedrunning 100K followers | One niche (the planner's subtopics), daily volume, pillars from data (the loop), a differentiation path (#109) | Planner, Learning |
| 85 | Consistent volume; channels are TV series | The planner's calendar; rule `series_look` | Planner |
| 86 | Content formulas | `contentGrid`: subtopics x formats x layouts | Planner |
| 87 | The 6x5 method | `contentGrid` method `6x5` | Planner |
| 88 | The 532 method | `contentGrid` method `532` | Planner |
| 89 | The 331 strategy | `contentGrid` method `331`; the tenth video is a `legoVariations` of the best | Planner |
| 90 | The 321 strategy | `WEEK_321` | Planner |
| 91 | Audience bullseye 3-2-2 | `BULLSEYE_WEEK`, rings per job, `JOB_WEEK` | Planner |
| 92 | The viral trap | The planner never aims at the broadest ring, and keeps convert videos in every week | Planner |
| 93 | Audience of one | The convert job at the bullseye ring | Planner |
| 94 | The empty-calorie trap | The convert job's direction: agitate a narrow pain, tease a non-obvious answer | Encoded |
| 95 | Only three metrics matter | The learning loop's measures: views (outliers), followers per video, conversions per view | Learning |
| 96 | Flashbang brain: one job per video | `VIDEO_JOBS`; rule `one_job` | Encoded |
| 97 | Super shares | A concept may aim at one big creator's audience; it depends on someone else's choice, so nothing is automated | Outside direction |
| 98 | The five content games | `CONTENT_GAMES`; `JOB_WEEK` per game | Planner |
| 99 | The three worst pieces of advice | One niche per plan; jobs, not views, as the goal | Planner |
| 100 | From variety show to TV network | One format, topic and goal per channel is a planner input per account | Planner |
| 101 | The rogue employee strategy | Secret brand-owned "fan" accounts hide who is speaking; that conflicts with platform authenticity rules and advertising-disclosure law, and with Meridian's no-deception rule | Not adopted |
| 102 | Instagram Shops | Product tagging belongs to publishing and commerce | Outside direction |
| 103 | Audience math and platform choice | A business decision about platforms | Outside direction |
| 104 | Master the skill before content | Shapes the brand, not a video; direction never claims a skill or result the brief does not show | Outside direction |
| 105 | An A-tier content team | Hiring; the direction run does the content operator's research, ideation and scripting | Outside direction |
| 106 | A YouTube script in four steps | Long-form: a future long-form cookbook (packaging first, body blocks, intro last) | Outside direction |
| 107 | Surfing the AI tidal wave | Rule `high_effort`; the originality floor; weak spots W1 and W14 | Encoded |

## 6. Personal brand, trust and authority

| # | Lesson | Where it lives | Status |
| --- | --- | --- | --- |
| 108 | The holy trinity of personal brands | Trust rules: proof only from the brief; the trust ladder | Encoded |
| 109 | Five creator moats | A brand-positioning input (the brand brain); rule `high_effort` | Outside direction |
| 110 | The trust ladder | `TRUST_LADDER` | Encoded |
| 111 | Demonstrated over owned over borrowed | `TRUST_LADDER` order; `TRUST_ANCHOR_TYPES` ranked | Encoded |
| 112 | Trust from proof; results in the lock-in | Lock-in approach `tease_proof`; check `trust_anchor` (proof early) | Checked |
| 113 | The Pavlovian effect | Rubric `density` and `novelty`; the planner's consistency | Encoded |
| 114 | Term branding | Rule `term_branding` | Encoded |
| 115 | Identity labels and demeanour matching | Hook family `identity_callout`; demeanour is part of the brand voice profile proposed in `INTEGRATION.md` | Encoded |
| 116 | Rich versus poor viewers | The convert job's direction (known pains, verifiable proof, strategy); the reach job's (fast, big outcome) | Encoded |
| 117 | The fandom funnel | The jobs, in order: reach, follow, convert | Encoded |
| 118 | Worldbuilding | A brand matter; rule `series_look` covers the aesthetic | Outside direction |
| 119 | The internet echo | Clipping a long-form source belongs to the engine's repurpose stage (`src/engine/repurpose/`) | Outside direction |
| 120 | Content minutes and binge-ability | The follow job; series in the planner | Planner |

## 7. Conversion, CTAs and lead magnets

| # | Lesson | Where it lives | Status |
| --- | --- | --- | --- |
| 121 | Comment-keyword to DM lead magnet | Script field `cta` (`keyword`, `offer`); rule `native_cta`; check `cta_alignment`. Adapted: only for the convert job, the keyword names the topic, and the resource must be one the brief names. A keyword request for a real resource is not the bait the lexicon refuses ("comment YES") | Checked, Adapted |
| 122 | Native embed CTAs | Rule `native_cta`; check `cta_alignment` | Checked |
| 123 | Email capture: pain, then solution | The convert job's direction | Encoded |
| 124 | The modern content stack | Long-form and email are channels, not direction; Meridian makes every short video natively for its format | Outside direction |
| 125 | The best lead magnets | The offer is the brand's; the CTA may only offer what the brief names | Outside direction |
| 126 | The goldilocks format | `VIRALITY_STACK` and rule `broad_to_narrow`: a broad hook, then a narrow takeaway and an aligned CTA | Encoded |
| 127 | Grow without going viral | The convert job; `JOB_WEEK.authority_services` | Planner |
| 128 | Three reasons content brings no leads | Narrow topics (convert job), proof (trust anchor), differentiation (core argument) | Encoded |
| 129 | The CTA strategist | Which CTA attributes move leads per 1,000 views is study R14 | Learning |
| 130 | Desire hooks attract buyers | Hook family `desire_outcome` | Encoded |
| 131 | Launch mechanics | A campaign matter; any scarcity or date must be true (rule `no_fake_urgency`) | Outside direction |

## 8. AI workflows

| # | Lesson | Where it lives | Status |
| --- | --- | --- | --- |
| 132 | Batch video analysis | Meridian's discovery and `analyze_reference` already do this | Encoded |
| 133 | Channel analysis: why the best hooks won | Study R12 (word patterns of winners and losers) | Learning |
| 134 | When a channel broke out, and why | The learning loop on the brand's history | Learning |
| 135 | A weekly channel scan | The standing loop's weekly pass | Learning |
| 136 | An outlier leaderboard | `outliers`; the weekly pass | Planner |
| 137 | The hook machine and hook grader | The concept lab on hook families (keep the psychology, change the words), graded by the report; never copied (the copy check) | Encoded |
| 138 | The story audit: hidden word patterns | Study R12 | Learning |
| 139 | A/B script coaching | Study R12, and a `script_coach` role proposed in `INTEGRATION.md` | Learning |
| 140 | Memory stacking: how I talk, how you work, who I am | A brand voice profile, proposed in `INTEGRATION.md` as an input to every direction prompt | Learning |
| 141 | The AI tool stack | Framework 12.3: models chosen by capability from the live catalogue, never by name; music stays an open question for the owner (Bible 20.2) | Encoded |
| 142 | The content growth system | The niche genome (framework 14.1), the planner, the pipeline and the studies | Planner, Learning |
| 143 | AI will not one-shot a banger | A run is `ready` only when every check passes and the rankings are reliable; otherwise a person decides. Real viewers pick winners | Encoded |
| 144 | Meta Ads creative studio (sponsored) | Ads tooling | Outside direction |

## 9. Older and other accounts

| # | Lesson | Where it lives | Status |
| --- | --- | --- | --- |
| 145 | Build-along content | Formats `live_breakdown` and `behind_the_scenes` | Encoded |
| 146 | Curated reference libraries | The codex is the library; the discovery corpus feeds it | Encoded |
| 147 | The podcast series | Covered by lessons 2, 75, 83, 98 and 120 | Encoded |

## Totals

| Status | Lessons |
| --- | --- |
| Checked (a check runs on every script) | 20 |
| Encoded (rules, lists, prompts) | 75 |
| Planner | 27 |
| Learning (needs the brand's own results) | 15 |
| Adapted (with a stated change) | 6 |
| Not adopted | 2 (clip-stitch hooks, rogue employee accounts) |
| Outside direction | 13 |

A lesson can carry more than one status, so the counts add up to more than 147.
