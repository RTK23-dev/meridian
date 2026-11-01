-- The style preset a video was briefed with: a plain id from the preset library (src/lib/meridian/content-factory/style-presets.ts), or null when
-- none was chosen. It steers the brief only; it is a record of what the person (or Auto) chose, not a render setting.
alter table content_factory_sessions
  add column if not exists style_preset text check (style_preset is null or char_length(style_preset) between 1 and 40);
