-- Migration 0052: the append-only audit tables keep their rows when a parent is deleted.
--
-- decision_reviews (0049) and opportunity_direction_decisions (0051) declared foreign keys with ON DELETE CASCADE. Both
-- tables refuse UPDATE and DELETE. So deleting an organization, brand, opportunity or decision that had an audit row
-- raised "append-only" from the cascade and blocked the deletion. The audit rows are kept as plain references instead.
-- Every query that reads them filters by organization and brand, so tenant scope does not depend on these keys.

alter table decision_reviews drop constraint if exists decision_reviews_organization_id_fkey;
alter table decision_reviews drop constraint if exists decision_reviews_brand_id_fkey;
alter table decision_reviews drop constraint if exists decision_reviews_decision_id_fkey;

alter table opportunity_direction_decisions drop constraint if exists opportunity_direction_decisions_organization_id_fkey;
alter table opportunity_direction_decisions drop constraint if exists opportunity_direction_decisions_brand_id_fkey;
alter table opportunity_direction_decisions drop constraint if exists opportunity_direction_decisions_opportunity_id_fkey;
