-- Migration 0151: a cookbook id is unique per brand, not across the whole workspace.
--
-- Until now (organization_id, cookbook_id, version) was unique. A member of one brand who tried to save an id that another brand already
-- used was told the id was taken, which revealed that the other brand's cookbook existed. The key now includes the brand (null for a
-- workspace-shared cookbook), so each brand has its own ids. A workspace-shared cookbook and a brand's own can use the same id: the
-- brand's own is the one that brand reads (cookbooks/store.ts). Additive for data: no row changes. The old key is a subset of the new one,
-- so every existing row still satisfies it.

alter table cookbooks drop constraint if exists cookbooks_organization_id_cookbook_id_version_key;

create unique index if not exists uq_cookbooks_scope_version
  on cookbooks (organization_id, coalesce(brand_id, ''), cookbook_id, version);
