-- Decision record identity (P3b; see jev/decision-record.ts).
--
-- decision_fingerprint identifies the question and its version, the provider, model, policy and calibration, the thresholds,
-- the input judged, and the evidence set. outcome_digest covers what the decision said. The same evidence under the same
-- question version has the same fingerprint, and a reproducible rerun has the same outcome digest.
--
-- Rows written before this migration keep the empty defaults. They are not reproducibility-checked. They are not fingerprinted
-- now either, because their stored fields may not match the inputs they were produced from.

alter table jev_decisions add column if not exists decision_fingerprint text not null default '';
alter table jev_decisions add column if not exists outcome_digest text not null default '';

create index if not exists jev_decisions_fingerprint_idx on jev_decisions (organization_id, brand_id, decision_fingerprint);
