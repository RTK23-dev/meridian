-- 0099: Content Factory sessions (the /content-factory screen). An admin starts a video from any idea in a chat thread: messages,
-- files from their computer and references to records on other Meridian pages. One "Make the video" run per session starts one video
-- engine request (src/engine/api). Revisions are later.
--
-- Tenancy: every row carries organization_id, and composite foreign keys keep each child in its parent's workspace. A session's brand
-- is optional (the engine accepts a request with no brand); when set it must be a brand of the same workspace.
--
-- Files are untrusted. A file row records the stored object (Meridian's storage layer: Google Drive, indexed by storage_objects), its
-- media type as checked from the bytes, its size and its SHA-256. The bytes are never stored here. A reference video is analysed only;
-- its footage never enters a render (Video Engine Bible principle 4), and the engine deletes the source media after analysis (6.2).
-- A source row records the page and the record it points at, with a short text snapshot shown to the user. Sources are read only.

-- brands.id is the primary key, so this index holds for every existing row. It lets a child row name its brand and its workspace together.
create unique index if not exists brands_organization_id_id_key on brands (organization_id, id);

create table if not exists content_factory_sessions (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text,
  created_by text references "user" (id) on delete set null,
  title text not null check (char_length(title) between 1 and 120),
  status text not null default 'draft' check (status in ('draft', 'started')),
  -- The engine request the run started, set in the same transaction that queues it. Null until then.
  engine_request_id text,
  -- What the person set for the video. Null means not set: nothing is defaulted, and the engine's schema names what is missing.
  budget_usd numeric(14, 4) check (budget_usd is null or budget_usd > 0),
  max_seconds integer check (max_seconds is null or (max_seconds between 5 and 180)),
  language text check (language is null or char_length(language) between 2 and 20),
  priority text check (priority is null or priority in ('rush', 'normal', 'batch')),
  keep_genes text not null default '[]',
  -- The last refusal of "Make the video", as a JSON list of plain sentences. Empty when the run was never refused.
  last_refusal text not null default '[]',
  started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_factory_sessions_org_id_key unique (organization_id, id),
  constraint content_factory_sessions_brand_fkey foreign key (organization_id, brand_id) references brands (organization_id, id) on delete cascade,
  constraint content_factory_sessions_request_fkey foreign key (organization_id, engine_request_id) references engine_requests (organization_id, id),
  constraint content_factory_sessions_started_check check ((status = 'started') = (engine_request_id is not null))
);

create index if not exists content_factory_sessions_org_idx on content_factory_sessions (organization_id, updated_at desc);
create unique index if not exists content_factory_sessions_request_key on content_factory_sessions (organization_id, engine_request_id)
  where engine_request_id is not null;

create table if not exists content_factory_messages (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  session_id text not null,
  author_id text references "user" (id) on delete set null,
  text text not null default '' check (char_length(text) <= 4000),
  -- Null for an instruction. A script line names its beat role (engine contract request.ts BEAT_ROLES).
  beat_role text check (beat_role is null or beat_role in ('hook', 'setup', 'item', 'proof', 'twist', 'payoff', 'cta')),
  created_at timestamptz not null default now(),
  constraint content_factory_messages_org_id_key unique (organization_id, id),
  constraint content_factory_messages_session_fkey foreign key (organization_id, session_id)
    references content_factory_sessions (organization_id, id) on delete cascade,
  constraint content_factory_messages_script_check check (beat_role is null or char_length(btrim(text)) > 0)
);

create index if not exists content_factory_messages_session_idx on content_factory_messages (organization_id, session_id, created_at);

create table if not exists content_factory_attachments (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  session_id text not null,
  message_id text not null,
  kind text not null check (kind in ('file', 'source')),
  -- file: the reference video (at most one per session) or other material.
  purpose text check (purpose is null or purpose in ('reference_video', 'material')),
  file_name text,
  storage_object_id text references storage_objects (id) on delete set null,
  storage_key text,
  media_type text,
  byte_size bigint check (byte_size is null or byte_size > 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  -- source: the page, the record and its brand, with the snapshot shown to the user.
  source_page text check (source_page is null or source_page in ('brain', 'product', 'library', 'page', 'market')),
  source_brand_id text,
  source_record_id text,
  snapshot text check (snapshot is null or char_length(snapshot) <= 800),
  created_at timestamptz not null default now(),
  constraint content_factory_attachments_message_fkey foreign key (organization_id, message_id)
    references content_factory_messages (organization_id, id) on delete cascade,
  constraint content_factory_attachments_session_fkey foreign key (organization_id, session_id)
    references content_factory_sessions (organization_id, id) on delete cascade,
  constraint content_factory_attachments_source_brand_fkey foreign key (organization_id, source_brand_id)
    references brands (organization_id, id) on delete cascade,
  constraint content_factory_attachments_shape_check check (
    (kind = 'file' and purpose is not null and file_name is not null and storage_key is not null and media_type is not null
      and byte_size is not null and sha256 is not null and source_page is null and source_record_id is null)
    or
    (kind = 'source' and source_page is not null and source_record_id is not null and source_brand_id is not null and snapshot is not null
      and purpose is null and storage_key is null and sha256 is null)
  )
);

create index if not exists content_factory_attachments_session_idx on content_factory_attachments (organization_id, session_id, created_at);
create unique index if not exists content_factory_attachments_reference_key on content_factory_attachments (organization_id, session_id)
  where purpose = 'reference_video';
