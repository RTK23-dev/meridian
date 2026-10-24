-- A paused Meta ad created from an uploaded repurposed variation, inside an ad set the person chose. The receipt is written only after Meta
-- returned the ad's id and a read-back showed it as PAUSED, so the table can never record a paused ad that was not verified paused. A
-- paused ad is not an activated ad, and nothing here starts delivery: activation is a separate action that is not built.
alter table content_factory_repurpose_publications drop constraint if exists content_factory_repurpose_publications_kind_check;

alter table content_factory_repurpose_publications
  add constraint content_factory_repurpose_publications_kind_check check (kind in ('meta_ad_video', 'meta_paused_ad'));

alter table content_factory_repurpose_publications add column if not exists ad_set_id text;
alter table content_factory_repurpose_publications add column if not exists meta_creative_id text;
alter table content_factory_repurpose_publications add column if not exists page_id text;
alter table content_factory_repurpose_publications add column if not exists destination_url text;
alter table content_factory_repurpose_publications add column if not exists verified_status text;

alter table content_factory_repurpose_publications
  add constraint content_factory_repurpose_publications_paused_verified check (
    kind <> 'meta_paused_ad'
    or (ad_set_id is not null and meta_creative_id is not null and page_id is not null and destination_url is not null and verified_status = 'PAUSED')
  );
