-- 0029: Nullable Perception & Content Analysis Features
-- Removes artificial zero and string defaults for unobserved multimodal features.

alter table jev_content_analyses
  alter column hook_visual_score drop not null,
  alter column hook_visual_score drop default,
  alter column audio_energy_score drop not null,
  alter column audio_energy_score drop default,
  alter column speech_wpm drop not null,
  alter column speech_wpm drop default,
  alter column motion_intensity drop not null,
  alter column motion_intensity drop default,
  alter column text_density drop not null,
  alter column text_density drop default;
