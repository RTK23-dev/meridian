-- A small, obviously synthetic fixture for the restore drill (.github/workflows/restore-drill.yml and local drills). It gives the drill
-- rows to count in a few core tables. Never run it against a real deployment: it adds a workspace named "Restore drill fixture".
-- Idempotent: running it twice adds nothing.

insert into organizations (id, name, slug, created_by)
values ('org_restore_drill', 'Restore drill fixture', 'restore-drill-fixture', 'user_restore_drill')
on conflict (id) do nothing;

insert into brands (id, organization_id, name, created_by)
select 'brand_restore_drill_' || n, 'org_restore_drill', 'Drill brand ' || n, 'user_restore_drill'
from generate_series(1, 3) as n
on conflict (id) do nothing;

insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status)
select 'job_restore_drill_' || n, 'org_restore_drill', 'brand_restore_drill_' || (1 + n % 3), 'restore.drill.fixture',
       'restore-drill-' || n, case when n % 2 = 0 then 'succeeded' else 'dead' end
from generate_series(1, 25) as n
on conflict (id) do nothing;
