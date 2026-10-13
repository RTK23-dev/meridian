-- Content Factory: learning per surface in Pick, and the JEV prediction each pick was made under (NORTH_STAR section 8, items 10
-- and 11). Both columns are added to factory_picks, which already holds one row per pick.
--
-- surface: the surface whose learned pattern weighted the pick, `organic` or `paid`. A run with intent both weights each concept on
-- both surfaces, and keeps one pick per concept, on the surface whose draw ranked first. A pick written before this migration has ''.
--
-- grade_fingerprint: a fingerprint of the JEV grade the pick's ad carried when the pick was made. The grade itself is not copied: it
-- stays in ad_timelines, where the jev_* columns already hold the engine, model, question versions and action (migration 0067). The
-- run view compares the stored fingerprint with the ad's grade now. A match shows the prediction the pick was made under. A change
-- says the ad was graded again since. A pick written before this migration has ''.

alter table factory_picks
  add column if not exists surface text not null default '' check (surface in ('', 'organic', 'paid')),
  add column if not exists grade_fingerprint text not null default '';
