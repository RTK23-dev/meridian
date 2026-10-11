-- Which credential a perception run used: the workspace's own saved key, or the deployment's shared default. Recorded so an
-- audit can show whose key analysed the media.
alter table perception_runs add column if not exists credential_source text;
