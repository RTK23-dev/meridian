-- Keep one durable frontier item per URL and run. Prefer the furthest-progressed state.
with ranked as (
  select id, row_number() over (
    partition by run_id, url
    order by case status
      when 'COMPLETED' then 0
      when 'PROCESSING' then 1
      when 'LEASED' then 2
      when 'RETRY' then 3
      when 'PENDING' then 4
      else 5
    end, discovered_at, id
  ) as position
  from discovery_frontier
)
delete from discovery_frontier f
using ranked r
where f.id = r.id and r.position > 1;

create unique index if not exists uq_discovery_frontier_run_url
  on discovery_frontier (run_id, url);
