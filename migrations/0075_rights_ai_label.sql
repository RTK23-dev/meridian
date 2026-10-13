-- The AI-label confirmation is recorded on the rights_attestations table, the same way as a licence attestation (owner decision on the
-- AI label; NORTH_STAR section 2). 0073 wrote the kind check for the two licences only. This replaces that check with one that also
-- accepts 'ai_label'. Nothing else in the table changes, and 0073 itself is not edited.
alter table rights_attestations drop constraint if exists rights_attestations_kind_check;
alter table rights_attestations add constraint rights_attestations_kind_check check (kind in ('music', 'footage', 'ai_label'));
