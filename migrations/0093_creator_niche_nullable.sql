-- A creator's niche is unknown until a source says what it is. Unknown stays null (no guessed default). The column was not null with
-- the default 'general', so an upsert that passes an unknown niche as null failed. Both the constraint and the default are dropped.
-- Existing rows keep the value they have.
alter table creators alter column niche drop not null;
alter table creators alter column niche drop default;
