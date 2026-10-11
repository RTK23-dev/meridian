-- Where a person left off in a brand's brain: the section they were in, the fields they changed, and when. One row per brand.
-- The brain screen writes it (on a save and when a section is opened) and reads it when the brain opens again.
-- current_section is an id from BRAIN_SECTION_IDS in src/lib/meridian/brain.ts, or empty when nothing was recorded yet.
-- touched_fields is a JSON array of brain field keys. Empty means no field has been changed through the brain screen.
create table if not exists brand_brain_progress (
  brand_id text primary key references brands (id) on delete cascade,
  current_section text not null default '',
  touched_fields text not null default '[]',
  updated_by text not null default '',
  updated_at timestamptz not null default now()
);
