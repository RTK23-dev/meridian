-- Content Factory: video and carousel production (NORTH_STAR section 8, item 3).
--
-- factory_creatives: a carousel is one creative with one row per slide. Each slide is linked to its variant with format 'carousel'
-- and its position in slide_index (0 for the first slide). The carousel itself, and every single image, video and carousel row, has
-- slide_index -1. The key is now (variant, format, slide), so a carousel's slides and its carousel row do not collide.
--
-- factory_runs.waiting_on: the stage a run is waiting at while a provider job it needs has not finished. A run waiting for a video
-- keeps status 'running' and its reason in error. The stages after the waiting stage do not run until it is cleared, and the stage
-- that waits checks again later. '' means the run is not waiting.

alter table factory_creatives add column if not exists slide_index integer not null default -1;
alter table factory_creatives drop constraint if exists factory_creatives_pkey;
alter table factory_creatives add constraint factory_creatives_pkey primary key (variant_id, format, slide_index);

alter table factory_runs add column if not exists waiting_on text not null default '';
