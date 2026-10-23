// The audit log's query (the admin audit screen and its CSV export). Plain SQL over a Sql handle, with no server-function imports, so the
// filters run against a real database in tests. An empty date filter is SQL null: an empty string is not a date, and Postgres refuses to
// cast it, so the date branch is skipped instead.

import type { Sql } from "../learning/store.ts";

export type AuditFilters = {
  organizationId: string;
  actor: string;
  action: string;
  brandId: string;
  from: string;
  to: string;
  page: number;
};

/** A date filter as a query parameter: null when it is empty, so the date is never cast from an empty string. */
function dateParam(value: string): string | null {
  return value === "" ? null : value;
}

export async function selectAuditRows(sql: Sql, f: AuditFilters, limit: number, offset: number): Promise<Record<string, unknown>[]> {
  const from = dateParam(f.from);
  const to = dateParam(f.to);
  return sql<Record<string, unknown>>`
    select a.id, a.actor_id, coalesce(u.name, '') as actor_name, a.action, a.brand_id,
      coalesce(b.name, '') as brand_name, a.object_type, a.object_id, a.metadata, a.created_at
    from audit_log a
    left join "user" u on u.id = a.actor_id
    left join brands b on b.id = a.brand_id and b.organization_id = a.organization_id
    where a.organization_id = ${f.organizationId}
      and (${f.actor} = '' or a.actor_id ilike '%' || ${f.actor} || '%' or coalesce(u.name, '') ilike '%' || ${f.actor} || '%')
      and (${f.action} = '' or a.action ilike '%' || ${f.action} || '%')
      and (${f.brandId} = '' or a.brand_id = ${f.brandId})
      and (${from}::date is null or a.created_at >= ${from}::date)
      and (${to}::date is null or a.created_at < (${to}::date + interval '1 day'))
    order by a.created_at desc, a.id desc
    limit ${limit} offset ${offset}
  `;
}

export async function countAuditRows(sql: Sql, f: AuditFilters): Promise<number> {
  const from = dateParam(f.from);
  const to = dateParam(f.to);
  const rows = await sql<{ count: unknown }>`
    select count(*) as count from audit_log a left join "user" u on u.id = a.actor_id
    where a.organization_id = ${f.organizationId}
      and (${f.actor} = '' or a.actor_id ilike '%' || ${f.actor} || '%' or coalesce(u.name, '') ilike '%' || ${f.actor} || '%')
      and (${f.action} = '' or a.action ilike '%' || ${f.action} || '%')
      and (${f.brandId} = '' or a.brand_id = ${f.brandId})
      and (${from}::date is null or a.created_at >= ${from}::date)
      and (${to}::date is null or a.created_at < (${to}::date + interval '1 day'))
  `;
  return Number(rows[0]?.count ?? 0);
}

