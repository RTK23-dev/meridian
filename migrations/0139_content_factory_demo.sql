-- Demo mode: a demo batch is made of fixture rows, marked here so nothing treats it as real work. A demo session or batch carries demo = true.
-- Reports that count real videos (hook history, economics) leave demo rows out. No video file exists for a demo row.
alter table content_factory_sessions add column if not exists demo boolean not null default false;
alter table content_factory_batches add column if not exists demo boolean not null default false;
