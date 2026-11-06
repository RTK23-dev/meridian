-- Four more model seats, so the workspace's OpenRouter key can serve them (owner direction 2026-11-06): reference analysis (a model that
-- takes images), speech to text (a model that takes audio), and the Studio's image and video models. Each is an explicit choice from the
-- live catalogue. A task with no choice keeps its own provider (Gemini, Deepgram, Nano Banana, Omni) when that provider's key is saved.
alter table generation_task_models drop constraint if exists generation_task_models_task_check;
alter table generation_task_models add constraint generation_task_models_task_check
  check (task in (
    'copy', 'research_analysis', 'brain_suggest', 'vision', 'direction_writer', 'direction_judge',
    'reference_analysis', 'transcription', 'studio_image', 'studio_video'
  ));
