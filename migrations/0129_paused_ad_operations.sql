-- A paused Meta ad is one recoverable operation per repurposed variation and ad account (repurpose-paused-ad.ts). Its states replace the
-- pending/verified pair of migrations 0127 and 0128:
--   claimed           owned by one request; no create has been sent
--   creative_attempt  a creative create may have reached Meta
--   ad_attempt        an ad create may have reached Meta (its creative id is recorded)
--   uncertain         an attempt may have reached Meta and its outcome is unknown; only a reconciliation may act
--   unexpected        an object exists that is not a verified paused ad; it is shown, and never changed by Meridian
--   refused           Meta definitively refused the create and created nothing; a request may reopen it with corrected inputs
--   verified          Meta returned the ad id, a read-back showed the ad PAUSED in this ad set, and the receipt was stored
--
-- The bound inputs (ad set, Page, destination, and a fingerprint of every creation input) are written once. A takeover never rewrites them.
-- Only a refused operation can be reopened with different inputs, and the previous inputs are kept in the events table.
-- lease_token is a fencing token: every write by an attempt names the token it was given, so a request whose lease was taken over cannot
-- record an outcome or send another create.

alter table content_factory_repurpose_publications drop constraint if exists content_factory_repurpose_publications_paused_state;
alter table content_factory_repurpose_publications drop constraint if exists content_factory_repurpose_publications_state_check;
alter table content_factory_repurpose_publications drop constraint if exists content_factory_repurpose_publications_paused_operation;

alter table content_factory_repurpose_publications add column if not exists operation_name text;
alter table content_factory_repurpose_publications add column if not exists input_fingerprint text;
alter table content_factory_repurpose_publications add column if not exists attempt integer not null default 1;
alter table content_factory_repurpose_publications add column if not exists lease_token text;
alter table content_factory_repurpose_publications add column if not exists lease_epoch integer not null default 0;
alter table content_factory_repurpose_publications add column if not exists lease_expires_at timestamptz;
alter table content_factory_repurpose_publications add column if not exists attempt_started_at timestamptz;
alter table content_factory_repurpose_publications add column if not exists meta_video_id text not null default '';
alter table content_factory_repurpose_publications add column if not exists ad_message text not null default '';
alter table content_factory_repurpose_publications add column if not exists reason text not null default '';
alter table content_factory_repurpose_publications add column if not exists updated_at timestamptz not null default now();

-- Rows written by migrations 0127 and 0128 were never released, so a row in a paused-ad state from those migrations has no marker and no
-- fingerprint. It is kept for review: uncertain, with the legacy fingerprint, so nothing reconciles or creates from it automatically.
update content_factory_repurpose_publications
set state = case when state = 'verified' then 'verified' else 'uncertain' end,
    input_fingerprint = coalesce(input_fingerprint, 'legacy'),
    operation_name = coalesce(operation_name, ''),
    reason = case when state = 'verified' then reason
                  else 'Recorded before the recovery fields existed. Review it in Meta before any new attempt.' end,
    lease_token = case when state = 'verified' then null else coalesce(lease_token, 'legacy') end
where kind = 'meta_paused_ad' and input_fingerprint is null;

alter table content_factory_repurpose_publications
  add constraint content_factory_repurpose_publications_state_check check (
    state in ('claimed', 'creative_attempt', 'ad_attempt', 'uncertain', 'unexpected', 'refused', 'verified')
  );

alter table content_factory_repurpose_publications
  add constraint content_factory_repurpose_publications_paused_operation check (
    kind <> 'meta_paused_ad'
    or (
      ad_set_id is not null and page_id is not null and destination_url is not null and input_fingerprint is not null
      and (
        (state = 'verified' and external_id <> '' and meta_creative_id is not null and verified_status = 'PAUSED' and lease_token is null)
        or (state = 'unexpected' and external_id <> '' and verified_status is not null and verified_status <> 'PAUSED' and lease_token is null)
        or (state = 'refused' and external_id = '' and lease_token is null)
        or (state in ('claimed', 'creative_attempt', 'ad_attempt', 'uncertain') and lease_token is not null)
      )
    )
  );

-- One row per recovery step. It is written in the same transaction as the change it records, and never updated or deleted. A rejected
-- request from a worker whose lease was taken over is recorded as 'fenced', so the audit trail shows what was refused and why.
create table if not exists content_factory_repurpose_publication_events (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  publication_id text not null references content_factory_repurpose_publications (id) on delete cascade,
  event text not null check (event in (
    'claimed', 'taken_over', 'reconcile_started', 'reopened', 'conflict', 'attempt_started', 'creative_created', 'ad_created',
    'verified', 'refused', 'uncertain', 'reconciled_absent', 'unexpected', 'fenced'
  )),
  lease_epoch integer not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists content_factory_repurpose_publication_events_idx
  on content_factory_repurpose_publication_events (organization_id, publication_id, created_at);
