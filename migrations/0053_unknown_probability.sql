-- 0053: an unknown probability is stored as NULL, never 0. A brief gate whose engine answers carried no probability records
-- no probability, and a stored 0 would read as a measured zero. jev_decisions.probability and confidence become nullable.
alter table jev_decisions
  alter column probability drop not null,
  alter column confidence drop not null;
