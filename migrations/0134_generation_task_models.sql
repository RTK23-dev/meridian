-- The workspace's model for each ordinary text-generation task: the studio's copy and scripts, the research analysis, the brand brain's
-- suggestions and the Factory's image labels. One row per workspace and task. A decision model is never stored here: the save path
-- requires a text model whose listed output is text (or, for image labels, a text model that also takes images), and the decision
-- engine keeps its own settings in decision_engine_openrouter_config. Pinned ids only: an alias is refused before it is stored.

create table if not exists generation_task_models (
  organization_id text not null references organizations (id) on delete cascade,
  task text not null check (task in ('copy', 'research_analysis', 'brain_suggest', 'vision')),
  model_id text not null check (char_length(model_id) between 3 and 200),
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, task)
);
