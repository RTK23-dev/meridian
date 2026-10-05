-- Meridian tenant model. Authorization is enforced in server functions;
-- these constraints keep the rows coherent.

create table if not exists organizations (
  id text primary key,
  name text not null,
  slug text not null unique,
  created_by text not null,
  brand_fit double precision not null default 0.25,
  historical_evidence double precision not null default 0.20,
  market_signal double precision not null default 0.15,
  novelty double precision not null default 0.15,
  reproducibility double precision not null default 0.10,
  saturation double precision not null default 0.10,
  risk double precision not null default 0.15,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists memberships (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  user_id text not null references "user" (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index if not exists memberships_user_idx on memberships (user_id);

create table if not exists user_settings (
  user_id text primary key references "user" (id) on delete cascade,
  active_organization_id text references organizations (id) on delete set null
);

create table if not exists brands (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  name text not null,
  description text not null default '',
  category text not null default '',
  industry text not null default '',
  website text not null default '',
  country_market text not null default '',
  sells text not null default '',
  status text not null default 'active' check (status in ('draft', 'active', 'archived')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists brands_org_idx on brands (organization_id) where deleted_at is null;

create table if not exists brand_brains (
  brand_id text primary key references brands (id) on delete cascade,
  target_customers text not null default '',
  problems text not null default '',
  desires text not null default '',
  objections text not null default '',
  positioning text not null default '',
  differentiators text not null default '',
  value_proposition text not null default '',
  tone text not null default '',
  personality text not null default '',
  writing_style text not null default '',
  words_to_use text not null default '',
  words_to_avoid text not null default '',
  preferred_formats text not null default '',
  preferred_channels text not null default '',
  required_disclaimers text not null default '',
  prohibited_claims text not null default '',
  automation_level text not null default 'manual'
    check (automation_level in ('manual', 'assisted', 'automated', 'autonomous')),
  provenance text not null default '{}',
  version integer not null default 1,
  updated_by text not null,
  updated_at timestamptz not null default now()
);

create table if not exists brand_brain_versions (
  id text primary key,
  brand_id text not null references brands (id) on delete cascade,
  version integer not null,
  snapshot text not null,
  note text not null default '',
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (brand_id, version)
);

create table if not exists products (
  id text primary key,
  brand_id text not null references brands (id) on delete cascade,
  name text not null,
  description text not null default '',
  features text not null default '',
  benefits text not null default '',
  price text not null default '',
  url text not null default '',
  allowed_claims text not null default '',
  prohibited_claims text not null default '',
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists products_brand_idx on products (brand_id) where deleted_at is null;

create table if not exists invites (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'member', 'viewer')),
  status text not null default 'recorded' check (status in ('recorded', 'accepted')),
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text references brands (id) on delete set null,
  actor_id text not null,
  action text not null,
  object_type text not null,
  object_id text not null,
  metadata text not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists audit_org_idx on audit_log (organization_id, created_at desc);
