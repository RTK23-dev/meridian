-- Triage states for an opportunity (prompt 13). Save, defer and request more research hold an idea out of the open list without
-- declining it, and reopen returns it to the open list. The two check constraints are widened; no existing row changes. Each name is the
-- one Postgres gives an inline column check (<table>_<column>_check).
alter table opportunities drop constraint if exists opportunities_status_check;
alter table opportunities add constraint opportunities_status_check
  check (status in ('open', 'accepted', 'dismissed', 'briefed', 'rejected', 'saved', 'deferred', 'needs_research'));

alter table opportunity_direction_decisions drop constraint if exists opportunity_direction_decisions_action_check;
alter table opportunity_direction_decisions add constraint opportunity_direction_decisions_action_check
  check (action in ('approve', 'decline', 'save', 'defer', 'request_research', 'reopen'));
