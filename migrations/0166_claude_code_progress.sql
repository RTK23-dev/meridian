-- 0166: what a Claude Code job is doing while it runs, and how long it took. The runner sends a short plain label with each heartbeat
-- ("Rendering", "Saving the video"); it never holds a link, a command or a tool's arguments. At the end the runner reports how many turns
-- Claude Code took and how long it ran, when Claude Code said so. Unknown stays null, never 0.

alter table claude_code_requests add column if not exists progress text not null default '';
alter table claude_code_requests add column if not exists turns integer;
alter table claude_code_requests add column if not exists duration_ms bigint;
