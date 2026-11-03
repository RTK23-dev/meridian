# Cookbooks: a guide

A **cookbook** is a saved recipe for one kind of video. It holds the style, the structure, the steps, the instructions for each part of the
process, what the video needs (a voice, music, a presenter, footage), and the options you can set. You pick a cookbook, set its options, see
what it needs and what it costs, and then send it to the orchestrator.

## Picking a cookbook

Meridian proposes cookbooks from what you give it: the brief, a reference video, a product kit, your uploads and your budget. Only cookbooks
that can run with those inputs are offered, and each one that is not offered says why (for example, "Presenter: needs your footage or a budget").

In a normal run you see the proposal, with the reason for the first choice and two alternatives. Nothing is sent to the orchestrator until you
confirm. You can change the cookbook, or change its options, first. In an automated loop the first choice is used as it is, and the record says
so.

## Options

Each cookbook sets its own options: toggles (on or off), sliders (a number in a range), choices (one of a list), text and colours taken from the
style. The screen shows what each option changes. Turning on a paid part (an AI voice, generated shots, an AI presenter) changes the badge and
the estimate, and it may take the run out of agent mode.

## Agent mode and engine mode

- **Agent mode** makes the video on your Claude plan. A Claude Code session writes the script, draws the scenes with coded components, renders
  them here and checks them against the cookbook's targets. No paid provider is called. It is available when every part the video needs is free:
  coded scenes, your own recording, your own footage.
- **Engine mode** makes the video with Meridian's pipeline and paid providers, under hard budget limits. The badge shows the estimated cost.

A cookbook that shows "Price unknown" has a paid part whose price cannot be worked out yet (for example, an AI voice before its length is known).
Meridian never shows that as free.

## Badges

- **Choose ...**: a part that the cookbook needs has no choice yet.
- **Price unknown**: a paid part whose cost is not known. It is not counted as zero.
- **Paid: about $X**: the known cost of the paid parts.
- **Free in agent mode**: nothing paid, and agent mode is available.
- **Free**: nothing paid, but agent mode is not offered for this cookbook.

## Saving your own cookbook

Change a cookbook's options or instructions and save it as your own. Each save is a new version; the old one is kept, so a past run can always
be read as it was made. A cookbook you save can be shared with the whole workspace or kept to the brand, as you choose. A copy of a built-in
cookbook is maintained by an admin.

## What the research uses

Each run records the cookbook, its version, the options you set, and whether the choice was confirmed, changed or automatic. Meridian learns
which settings give which results from those records. A measure that could not be read is shown as unknown, never as zero.

## What the owner still has to run live

- The first live call of the cookbook selector, once its model role is approved (decision Q34).
- A paid render in engine mode.
- A look check of the agent-mode scenes in a browser, where the GSAP script can load.

## Known limits

- **Ids are shared across a workspace's brands.** A cookbook id is unique in the whole workspace, so a member who tries to save an id that another brand already uses is told the id is taken ("a cookbook keeps its brand"). That reveals that the id exists, and nothing else: not the cookbook's name, its steps or its owner. Closing it means making the key per brand, which changes how a cookbook is looked up by id everywhere. It is a design decision for the owner, not a bug fix, and it has not been made.
