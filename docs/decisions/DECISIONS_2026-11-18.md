# Decisions, 2026-11-18

The owner gave full autonomy for the next phases ("any decision you need mine you decide on behalf of me"). These are the decisions made
under that direction, so they can be read, questioned and reversed. Each says what was decided, why, and what would change it.

1. **Launch is for the owner's own brands first, not outside customers.** Customer sign-up, payment and support would add a billing
   system and support duties before the product has a live video on record. Changes when: one live month on the owner's brands is
   recorded and the owner wants paying customers.
2. **1.1.0 stable waits only on the owner's live checks; building does not wait for it.** The live checks (runner with the real Claude
   Code, one Create run, one email, one Facebook post, one voiceover) need the owner's keys and accounts. Changes when: never; rule 5 of
   CLAUDE.md requires a recorded live run before a claim.
3. **After Facebook, the next posting channel is Instagram.** It shares the Meta account and app review with Facebook, so it costs the
   least new setup. It stays switched off until Facebook has one recorded live post.
4. **The Claude Code runner stays on the owner's own computers.** A hosted runner would bill Claude usage to Meridian and hold the
   owner's Claude sign-in on a server. Changes when: the owner wants videos made while every computer is off.
5. **Create is the one front door.** The other ways in stay reachable by their addresses, so nothing breaks, but navigation leads to Create.
6. **Posting to Instagram, YouTube and TikTok, paused ads and the Meta ad-account upload stay off.** Each can act twice on a retry and
   none has been tested against the real service. The organic channels already have the claim guard; each is switched on after one
   recorded live post.
7. **Alert webhooks and Google Drive writes are switched on behind guards** (an idempotency key and an "uncertain" state for a webhook;
   a reserved file id for Drive), because a duplicate there is recoverable and the guard is testable without the live service. If the
   Drive guard cannot be built small and testable, Drive writing stays off.
8. **Phase 4 (calibration on real outcomes) is not started.** It needs 200 real outcomes; building more before real data exists would be
   guessing. Changes when: measured results start arriving from posted videos.
