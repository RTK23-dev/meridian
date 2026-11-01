-- Category budgets (owner direction 2026-10-23, D3): a stored output records the budget category of the step that made it, so a later run
-- totals each category's spend from the stored outputs. Null for a step with no model call, and for an output stored before this migration:
-- a plan stored before it has no category budgets in its brief, so no category check reads its outputs. Added, never narrowed.

alter table orchestrator_step_outputs
  add column if not exists category text check (category is null or category in ('copy', 'creative', 'voice'));
