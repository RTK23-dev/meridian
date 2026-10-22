# Autonomous run: Content Factory items 2 to 8 and what else is left (2026-10-22)

Owner instruction: finish items 2 to 8 of `docs/engine/CONTENT_FACTORY_STATE_2026-10-18.md` section 4, and whatever else is left, in one run,
without waiting for the next command. Each item is committed to `main` with its tests. Nothing here calls a live provider.

## Design decisions made on the owner's behalf in this run

- **D7 Replacement shot spec.** A remake may replace one shot's spec (its visual type, its source, or its model choice). The engine writes a new
  scene plan artifact with that shot replaced, and the remake event names it. Replay gives the same state, because the event carries the id.
  Plans keep their beats and timing; only the one shot changes.
- **D8 Edit prompt is a directed remake.** `edit_prompt` is the reviewer's text for the shot, applied as a remake direction. It is the same path
  as the direction field on the board, so the 8-direction cap and the 280-character limit apply unchanged.
- **D9 Whole-video direction is a revision.** A direction for the whole video starts a revision, whose brief carries the direction. The full
  plan is made again, as the revision path does. Re-planning only the affected shots is not built; the revision is the honest form of it.
- **D10 Mid-run remake.** A shot that is still being made can be remade: its in-flight take becomes stale (a new epoch), and the in-flight call
  is not cancelled. Its cost stays on the ledger under the reservation that paid for it, and the stale take is never counted.

(Further decisions are appended below as they are made.)

## Status

| Item | State | Commit |
| --- | --- | --- |
| 14 replacement shot spec | in progress | |
| 2 review inbox actions | pending | |
| 3 reviewer clip | pending | |
| 4 model choice per remake | pending | |
| 5 mid-run remake | pending | |
| 6 whole-video direction | pending | |
| 7 splice render | pending | |
| 8 variants after remake | pending | |
| remaining: step handlers, re-render wiring, review items | pending | |
