-- A chain call belongs to a request of its own workspace. The key is composite, as the other engine tables use it, so a call
-- cannot point at another workspace's request, and deleting a request removes its chain calls with it.
alter table engine_chain_calls
  add constraint engine_chain_calls_request_fk
  foreign key (organization_id, request_id) references engine_requests (organization_id, id) on delete cascade;
