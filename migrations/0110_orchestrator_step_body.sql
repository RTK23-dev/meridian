-- Orchestrator step bodies (orchestrator-plan@1). Numbered after 0109.
--
-- A step's content is stored with its output, so a step that reads an upstream step is given what that step produced, not its hash.
-- A body is text the engine wrote or the user supplied (a script, an analysis, a reference's text). It is null for a step that has no
-- text content, and it is capped: a body is a short record, never media. Media is stored as an asset, and the output carries its hash.
--
-- Outputs stored before this migration have no body. A step that reads one is given no content and fails closed (execute.ts).

alter table orchestrator_step_outputs add column if not exists body text check (body is null or length(body) <= 200000);
