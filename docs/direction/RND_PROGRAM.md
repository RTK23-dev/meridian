# The direction research programme

Version 2, 2026-11-04. The framework's rules start as sourced findings, practice and hypotheses. This programme turns the hypotheses into
measured rules, finds the models that do each job best, and keeps the codex current. Each study names its question, its method, its data,
its success measure, its estimated cost, and what it needs from the owner. Agents run the offline studies; only real viewers settle the
rest.

## 1. What the first sprint delivered (2026-11-04)

- Research on platform signals, attention and virality, script craft, AI's creative weak spots and the model landscape (`EVIDENCE.md`).
- The framework (`VIRAL_DIRECTION_FRAMEWORK.md`), the codex and its checks, the direction pipeline, the live port, and the switch for
  cookbook scripts (`INTEGRATION.md`, section 1).
- Not done, because it needs money, accounts or people: any live model run, any test with an audience, any human taste panel.

## 2. The studies

| # | Question | Method | Data | Success measure | Cost (estimate) | Needs from the owner |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | Does the swipe tester predict real outcomes? | Pairwise: for each pair, which video beat the creator's median? Order-swapped, two judge families | Gold pairs: an outlier and a median video of the same creator, 40 pairs in each of 5 niches (200 pairs), from discovery data | Pairwise accuracy above 65% (framework 13), consistency above 0.6, first-shown win rate near 0.5 | About $5 of judge calls | Approval to run; the niches to start with |
| R2 | Does direction make better scripts? | Challenger split of `write_script` with and without the codex's script rules (`INTEGRATION.md`, step 1) | Production runs | Gate pass rate; blind preference of a viewer panel; then published results | The challenger's extra tokens, about 1,000 per script | Step 1's switch |
| R3 | Which divergence tools add range? | Ablation: concept lab alone, plus the deck, plus verbalized probability, plus a second family | 20 briefs, offline | Mean pairwise similarity of the concepts (lower), distinct hook families (higher), with panel quality held | About $3 | Approval to run |
| R4 | Which models judge best? | The same gold pairs through each candidate judge | R1's pairs | Accuracy, consistency, position bias, cost | About $5 | Approval; the candidate list from the live catalogue |
| R5 | Which models write best? | Blind pairwise viewer panel on scripts from 3 or 4 frontier writers, same concepts | 20 briefs | Human win rate; then published results | About $10 to $20, plus the panel | A human panel (target viewers, 10 people) |
| R6 | Is the slop lexicon precise? | Label lines as human-written or machine-written; measure each phrase's precision | 300 lines from published scripts and model drafts | Precision above 0.8 per kept phrase; prune the rest | No model cost; two hours of labelling | Labellers, or approval for a model-assisted label pass |
| R7 | Do the timing windows hold per platform? | Regress 3-second retention and average watch percentage on hook end time, promise time and longest stretch | The brand's own posts with retention data | A window that moves the metric, with its effect size | None | Connected accounts with retention insights |
| R8 | Does a native video model judge renders better than frames? | The same rendered videos to a frame-based critic and a native video-and-audio model; compare with human ratings | 50 renders | Correlation with human ratings | About $5 | Approval; a video-native route |
| R9 | Which hook families win in which niches? | Label the genome of outliers and medians in discovery data; estimate each family's win rate per niche | The discovery corpus | Priors per niche, with intervals, replacing the codex's defaults | About $10 of genome calls | Approval to run |
| R10 | Do loop seams raise replays? | A/B of one master with and without a seam on a trial audience | Trial reels | Replays per view; average watch percentage | The test budget | Trial reels access; a test budget |

### Studies added with codex 2 (the short-form lessons)

| # | Question | Method | Data | Success measure | Cost (estimate) | Needs from the owner |
| --- | --- | --- | --- | --- | --- | --- |
| R11 | Which power words carry a niche? | Mine the niche's top transcripts and text hooks; weight each word by the video's views and how early it appears; compare with median videos | Discovery corpus per niche | A power-word bank per niche, with each word's lift, read into the text-hook rules | About $5 of transcript passes | Approval; the niches |
| R12 | Which word patterns separate the brand's winners from its losers? | The story audit: the brand's best and worst ten scripts on one topic, compared phrase by phrase; then the script coach's changes, tested | The brand's scripts joined to results | Patterns that hold on the next ten videos | About $2 | Connected accounts with results |
| R13 | Where do the brand's viewers stay longer than expected? | Retention hunting: spikes in the flat part of each retention curve, and the line or picture at that moment | The brand's retention insights | Hooks drawn from spikes beat the brand's median hook | None | Retention insights access |
| R14 | Which call-to-action attributes move leads? | Tag each CTA (keyword, offer, place, framing); regress leads per 1,000 views on them | The brand's CTAs and leads | The attributes with an effect, and their size | None | A lead source per video (a DM tool or a CRM) |
| R15 | Is there a mushy middle in length for this brand? | Bucket the brand's videos by length and topic; compare average watch percentage and views | The brand's own posts | Length buckets that do better, per topic | None | Connected accounts |

## 3. A 24-hour run, if the owner authorizes it

Every hour block is something an agent can do once approved. The spend is estimated; the ledger records the real cost.

| Hours | Work | Spend (estimate) |
| --- | --- | --- |
| 0 to 4 | Build the gold pairs (R1) from discovery data in five niches; label the genome of each (R9's first pass). | about $10 |
| 4 to 8 | R1 and R4: the swipe tester and three candidate judges on the gold pairs; reliability and accuracy per judge. | about $10 |
| 8 to 12 | R3: the divergence ablation on 20 briefs. | about $3 |
| 12 to 16 | R5's model half: scripts from each candidate writer on the same concepts, ready for the human panel. | about $15 |
| 16 to 20 | Fold the results into `direction-codex@2`: judge and writer choices, pruned lexicon, niche priors. A pull request with the evidence attached. | none |
| 20 to 24 | Prepare R2's challenger and R10's trial test for the owner to start. | none |

What no agent does in that run: post anything, run paid ads, show content to a human panel, or change a gate without approval.

## 4. The standing loop

- **Nightly** (the existing sleep mode): join direction records to results; refit the priors within Bible 16.3's limits.
- **Weekly:** re-run the judge on the gold pairs; reset sampling when its accuracy falls (Bible 12.5).
- **Monthly:** a new codex version with a changelog: what was learned, what moved from `hypothesis` to `sourced` or was dropped.
- **Every model release:** re-run R4 and R5 for the new model before it may take a slot.

## 5. How a rule changes status

A `hypothesis` becomes a rule only when a study above measured it, with the data and the effect size in `EVIDENCE.md`. A rule that a
study contradicts becomes `contested`, then is removed in the next codex version. Nothing in the codex is promoted on a model's opinion.
