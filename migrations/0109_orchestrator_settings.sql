-- The orchestrator's model for a workspace, chosen in the Content Factory panel (owner direction 2026-10-21). One row per workspace.
-- A plan that names no model uses this one. It is stored as an OpenRouter id, never as a price: each plan prices the model from the
-- live catalog when it is written, and the engine refuses a model the catalog does not list as a text model.
-- Additive: the table is new and nothing else changes.

create table if not exists orchestrator_settings (
  organization_id text primary key references organizations (id) on delete cascade,
  orchestrator_model text not null check (length(orchestrator_model) between 3 and 200),
  updated_by text not null check (length(updated_by) between 1 and 200),
  updated_at timestamptz not null default now()
);
