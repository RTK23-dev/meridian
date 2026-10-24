-- A paused-ad claim is recorded BEFORE Meta is called. The row starts 'pending' with a lease (claimed_at). The database allows one row per
-- variation and ad account (the existing unique key), so two concurrent requests cannot both reach Meta: the second insert is refused and
-- reports "in progress". A pending row becomes 'verified' only after Meta returned the ad's id and a read-back showed it PAUSED. A pending
-- row whose lease has expired may be taken over; the take-over reconciles by ad name before it creates anything.
--
-- The idempotency key no longer includes the ad set. The rule is one paused ad per variation and ad account, enforced by the database.

alter table content_factory_repurpose_publications
  add column if not exists state text not null default 'verified';
alter table content_factory_repurpose_publications
  add column if not exists claimed_at timestamptz;

alter table content_factory_repurpose_publications drop constraint if exists content_factory_repurpose_publications_state_check;
alter table content_factory_repurpose_publications
  add constraint content_factory_repurpose_publications_state_check check (state in ('pending', 'verified'));

alter table content_factory_repurpose_publications drop constraint if exists content_factory_repurpose_publications_paused_verified;
alter table content_factory_repurpose_publications
  add constraint content_factory_repurpose_publications_paused_state check (
    kind <> 'meta_paused_ad'
    or (state = 'pending' and verified_status is null and claimed_at is not null)
    or (
      state = 'verified' and ad_set_id is not null and meta_creative_id is not null and page_id is not null
      and destination_url is not null and verified_status = 'PAUSED' and external_id <> ''
    )
  );
