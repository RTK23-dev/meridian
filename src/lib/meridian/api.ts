import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, type Sql } from "@/lib/db";
import { assertRole, isRole, nextOwnerCount, type Role } from "@/lib/meridian/access";
import {
  AUTOMATION_LEVELS,
  BRAIN_FIELDS,
  brainCompleteness,
  emptyBrain,
  isAutomationLevel,
  isProvenance,
  slugify,
  type AutomationLevel,
  type BrainKey,
  type BrainValues,
  type Provenance,
  type ProvenanceMap,
} from "@/lib/meridian/brain";
import {
  WEIGHT_KEYS,
  parseWeight,
  type ScoreWeights,
} from "@/lib/meridian/scoring";

export type OrgSummary = {
  id: string;
  name: string;
  slug: string;
  role: Role;
};

export type BrandSummary = {
  id: string;
  name: string;
  website: string;
  industry: string;
  sells: string;
  country: string;
  completeness: number;
  updatedAt: string;
};

export type AuditEntry = {
  id: string;
  action: string;
  actorName: string;
  objectType: string;
  objectId: string;
  brandId: string | null;
  createdAt: string;
  metadata: Record<string, string>;
};

export type MemberRow = {
  userId: string;
  name: string;
  email: string;
  role: Role;
};

export type InviteRow = {
  id: string;
  email: string;
  role: Role;
  status: string;
  createdAt: string;
};

export type Bootstrap = {
  organizations: OrgSummary[];
  active: (OrgSummary & { weights: ScoreWeights }) | null;
  brands: BrandSummary[];
  members: MemberRow[];
  invites: InviteRow[];
  audit: AuditEntry[];
  overviewMetrics: {
    failedJobs: number;
    livePublications: number;
    lastPerformanceSync: string | null;
  } | null;
};

export type BrandIdentity = {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  category: string;
  industry: string;
  website: string;
  country: string;
  sells: string;
  role: Role;
};

export type BrainVersion = {
  version: number;
  note: string;
  createdAt: string;
};

export type ProductRow = {
  id: string;
  name: string;
  description: string;
  features: string;
  benefits: string;
  price: string;
  url: string;
  allowedClaims: string;
  prohibitedClaims: string;
};

export type BrandDetail = {
  identity: BrandIdentity;
  brain: BrainValues;
  provenance: ProvenanceMap;
  version: number;
  versions: BrainVersion[];
  products: ProductRow[];
};

type Membership = { organizationId: string; role: Role };

function id(): string {
  return crypto.randomUUID();
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function asCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function asRecord(value: unknown): Record<string, string> {
  let source: unknown = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function clip(value: unknown, max: number, label: string, required = false): string {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return "";
    throw new Error(`${label} must be text.`);
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${label} is required.`);
  if (trimmed.length > max) throw new Error(`${label} is too long.`);
  return trimmed;
}

function optionalUrl(value: unknown, label: string): string {
  const raw = clip(value, 500, label, false);
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https.`);
  }
  return url.toString();
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid request.");
  }
  return input as Record<string, unknown>;
}

async function membership(
  sql: Sql,
  userId: string,
  organizationId: string,
): Promise<Membership | null> {
  const rows = await sql<{ role: string }>`
    select role from memberships
    where user_id = ${userId} and organization_id = ${organizationId}
    limit 1
  `;
  const role = rows[0]?.role;
  if (!role || !isRole(role)) return null;
  return { organizationId, role };
}

async function requireMembership(
  sql: Sql,
  userId: string,
  organizationId: string,
  minimum: Role,
): Promise<Membership> {
  const row = await membership(sql, userId, organizationId);
  if (!row) throw new Error("That workspace is not available to you.");
  assertRole(row.role, minimum);
  return row;
}

async function brandOrg(
  sql: Sql,
  brandId: string,
): Promise<{ organizationId: string } | null> {
  const rows = await sql<{ organization_id: string }>`
    select organization_id from brands
    where id = ${brandId} and deleted_at is null
    limit 1
  `;
  const organizationId = rows[0]?.organization_id;
  return organizationId ? { organizationId } : null;
}

async function writeAudit(
  sql: Sql,
  entry: {
    organizationId: string;
    brandId?: string | null;
    actorId: string;
    action: string;
    objectType: string;
    objectId: string;
    metadata?: Record<string, string>;
  },
): Promise<void> {
  await sql`
    insert into audit_log (
      id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata
    ) values (
      ${id()},
      ${entry.organizationId},
      ${entry.brandId ?? null},
      ${entry.actorId},
      ${entry.action},
      ${entry.objectType},
      ${entry.objectId},
      ${JSON.stringify(entry.metadata ?? {})}
    )
  `;
}

function brainFromRow(row: Record<string, unknown> | undefined): {
  brain: BrainValues;
  provenance: ProvenanceMap;
  version: number;
} {
  const brain = emptyBrain();
  const provenance: ProvenanceMap = {};
  if (!row) return { brain, provenance, version: 0 };
  for (const field of BRAIN_FIELDS) {
    brain[field.key] = asText(row[field.column]);
  }
  const level = asText(row.automation_level);
  brain.automationLevel = isAutomationLevel(level) ? level : "manual";
  const stored = asRecord(row.provenance);
  for (const field of BRAIN_FIELDS) {
    const value = stored[field.key];
    if (value && isProvenance(value)) provenance[field.key] = value;
  }
  const version = Number(row.version);
  return { brain, provenance, version: Number.isFinite(version) ? version : 1 };
}

function weightsFromRow(row: Record<string, unknown>): ScoreWeights {
  return {
    brandFit: Number(row.brand_fit),
    historicalEvidence: Number(row.historical_evidence),
    marketSignal: Number(row.market_signal),
    novelty: Number(row.novelty),
    reproducibility: Number(row.reproducibility),
    saturation: Number(row.saturation),
    risk: Number(row.risk),
  };
}

const BRAIN_COLUMNS = BRAIN_FIELDS.map((field) => `br.${field.column}`).join(", ");

export const bootstrap = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<Bootstrap> => {
    const sql = await getSql();
    const userId = context.userId;
    const organizations = await sql<{
      id: string;
      name: string;
      slug: string;
      role: string;
    }>`
      select o.id, o.name, o.slug, m.role
      from memberships m
      join organizations o on o.id = m.organization_id
      where m.user_id = ${userId}
      order by o.created_at asc
    `;
    const orgs: OrgSummary[] = organizations.flatMap((row) =>
      isRole(row.role)
        ? [{ id: row.id, name: row.name, slug: row.slug, role: row.role }]
        : [],
    );
    if (orgs.length === 0) {
      return {
        organizations: [],
        active: null,
        brands: [],
        members: [],
        invites: [],
        audit: [],
        overviewMetrics: null,
      };
    }
    const settings = await sql<{ active_organization_id: string | null }>`
      select active_organization_id from user_settings where user_id = ${userId} limit 1
    `;
    const preferred = settings[0]?.active_organization_id;
    const activeOrg = orgs.find((org) => org.id === preferred) ?? orgs[0];
    if (!activeOrg) {
      return { organizations: orgs, active: null, brands: [], members: [], invites: [], audit: [], overviewMetrics: null };
    }
    if (preferred !== activeOrg.id) {
      await sql`
        insert into user_settings (user_id, active_organization_id)
        values (${userId}, ${activeOrg.id})
        on conflict (user_id) do update set active_organization_id = ${activeOrg.id}
      `;
    }
    const weightRows = await sql<Record<string, unknown>>`
      select brand_fit, historical_evidence, market_signal, novelty,
             reproducibility, saturation, risk
      from organizations where id = ${activeOrg.id} limit 1
    `;
    const weights = weightRows[0] ? weightsFromRow(weightRows[0]) : {
      brandFit: 0.25,
      historicalEvidence: 0.2,
      marketSignal: 0.15,
      novelty: 0.15,
      reproducibility: 0.1,
      saturation: 0.1,
      risk: 0.15,
    };
    const brandsQuery = `
      select b.id, b.name, b.website, b.industry, b.sells, b.country_market, b.updated_at,
             ${BRAIN_COLUMNS}
      from brands b
      left join brand_brains br on br.brand_id = b.id
      where b.organization_id = $1 and b.deleted_at is null
      order by b.updated_at desc
    `;
    const loadedBrands = await sql.query<Record<string, unknown>>(brandsQuery, [activeOrg.id]);
    const brands: BrandSummary[] = loadedBrands.map((row) => {
      const { brain } = brainFromRow(row);
      return {
        id: asText(row.id),
        name: asText(row.name),
        website: asText(row.website),
        industry: asText(row.industry),
        sells: asText(row.sells),
        country: asText(row.country_market),
        completeness: brainCompleteness(brain).ratio,
        updatedAt: asText(row.updated_at),
      };
    });
    const members = await listMembers(sql, activeOrg.id);
    const invites = await sql<{
      id: string;
      email: string;
      role: string;
      status: string;
      created_at: unknown;
    }>`
      select id, email, role, status, created_at
      from invites
      where organization_id = ${activeOrg.id} and status in ('recorded', 'pending', 'sent')
      order by created_at desc
      limit 20
    `;
    const audit = await loadAudit(sql, activeOrg.id, null, 12);
    const overviewRows = await sql<{ failed_jobs: unknown; live_publications: unknown; last_performance_sync: unknown }>`
      select
        (select count(*) from jobs where organization_id = ${activeOrg.id} and status = 'dead') as failed_jobs,
        (select count(*) from provider_objects
          where organization_id = ${activeOrg.id} and provider in ('meta', 'tiktok', 'google')
            and object_type = 'ad' and status in ('stored', 'published')) as live_publications,
        (select max(created_at) from performance_observations
          where organization_id = ${activeOrg.id} and source in ('meta', 'tiktok', 'google')) as last_performance_sync
    `;
    return {
      organizations: orgs,
      active: { ...activeOrg, weights },
      brands,
      members,
      invites: invites.flatMap((row) =>
        isRole(row.role) && row.role !== "owner"
          ? [{
              id: row.id,
              email: row.email,
              role: row.role,
              status: row.status,
              createdAt: asText(row.created_at),
            }]
          : [],
      ),
      audit,
      overviewMetrics: overviewRows[0] ? {
        failedJobs: asCount(overviewRows[0].failed_jobs),
        livePublications: asCount(overviewRows[0].live_publications),
        lastPerformanceSync: overviewRows[0].last_performance_sync ? asText(overviewRows[0].last_performance_sync) : null,
      } : null,
    };
  });

async function listMembers(sql: Sql, organizationId: string): Promise<MemberRow[]> {
  const rows = await sql<{ user_id: string; name: string; email: string; role: string }>`
    select m.user_id, u.name, u.email, m.role
    from memberships m
    join "user" u on u.id = m.user_id
    where m.organization_id = ${organizationId}
    order by m.created_at asc
  `;
  return rows.flatMap((row) =>
    isRole(row.role)
      ? [{ userId: row.user_id, name: row.name, email: row.email, role: row.role }]
      : [],
  );
}

async function loadAudit(
  sql: Sql,
  organizationId: string,
  brandId: string | null,
  limit: number,
): Promise<AuditEntry[]> {
  const rows = brandId
    ? await sql<Record<string, unknown>>`
        select a.id, a.action, a.object_type, a.object_id, a.brand_id, a.metadata, a.created_at, u.name as actor_name
        from audit_log a left join "user" u on u.id = a.actor_id
        where a.organization_id = ${organizationId} and a.brand_id = ${brandId}
        order by a.created_at desc
        limit ${limit}
      `
    : await sql<Record<string, unknown>>`
        select a.id, a.action, a.object_type, a.object_id, a.brand_id, a.metadata, a.created_at, u.name as actor_name
        from audit_log a left join "user" u on u.id = a.actor_id
        where a.organization_id = ${organizationId}
        order by a.created_at desc
        limit ${limit}
      `;
  return rows.map((row) => ({
    id: asText(row.id),
    action: asText(row.action),
    actorName: asText(row.actor_name) || "System",
    objectType: asText(row.object_type),
    objectId: asText(row.object_id),
    brandId: row.brand_id ? asText(row.brand_id) : null,
    createdAt: asText(row.created_at),
    metadata: asRecord(row.metadata),
  }));
}

async function uniqueSlug(sql: Sql, name: string): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const existing = await sql<{ id: string }>`
      select id from organizations where slug = ${slug} limit 1
    `;
    if (existing.length === 0) return slug;
  }
  return `${base}-${id().slice(0, 8)}`;
}

export const createOrganization = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { name: clip(body.name, 80, "Workspace name", true) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const orgId = id();
    const slug = await uniqueSlug(sql, data.name);
    await sql`
      insert into organizations (id, name, slug, created_by)
      values (${orgId}, ${data.name}, ${slug}, ${context.userId})
    `;
    await sql`
      insert into memberships (id, organization_id, user_id, role)
      values (${id()}, ${orgId}, ${context.userId}, 'owner')
    `;
    await sql`
      insert into user_settings (user_id, active_organization_id)
      values (${context.userId}, ${orgId})
      on conflict (user_id) do update set active_organization_id = ${orgId}
    `;
    await writeAudit(sql, {
      organizationId: orgId,
      actorId: context.userId,
      action: "organization.created",
      objectType: "organization",
      objectId: orgId,
      metadata: { name: data.name },
    });
    return { id: orgId };
  });

export const setActiveOrganization = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { organizationId: clip(body.organizationId, 80, "Workspace", true) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "viewer");
    await sql`
      insert into user_settings (user_id, active_organization_id)
      values (${context.userId}, ${data.organizationId})
      on conflict (user_id) do update set active_organization_id = ${data.organizationId}
    `;
    return { ok: true };
  });

export const renameOrganization = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return {
      organizationId: clip(body.organizationId, 80, "Workspace", true),
      name: clip(body.name, 80, "Workspace name", true),
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");
    await sql`
      update organizations set name = ${data.name}, updated_at = now()
      where id = ${data.organizationId}
    `;
    await writeAudit(sql, {
      organizationId: data.organizationId,
      actorId: context.userId,
      action: "organization.renamed",
      objectType: "organization",
      objectId: data.organizationId,
      metadata: { name: data.name },
    });
    return { ok: true };
  });

export const updateWeights = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const organizationId = clip(body.organizationId, 80, "Workspace", true);
    const source = objectInput(body.weights);
    const weights = {} as ScoreWeights;
    for (const key of WEIGHT_KEYS) {
      weights[key] = parseWeight(source[key], key);
    }
    return { organizationId, weights };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");
    const w = data.weights;
    await sql`
      update organizations set
        brand_fit = ${w.brandFit},
        historical_evidence = ${w.historicalEvidence},
        market_signal = ${w.marketSignal},
        novelty = ${w.novelty},
        reproducibility = ${w.reproducibility},
        saturation = ${w.saturation},
        risk = ${w.risk},
        updated_at = now()
      where id = ${data.organizationId}
    `;
    await writeAudit(sql, {
      organizationId: data.organizationId,
      actorId: context.userId,
      action: "scoring.updated",
      objectType: "organization",
      objectId: data.organizationId,
      metadata: Object.fromEntries(WEIGHT_KEYS.map((key) => [key, String(w[key])])),
    });
    return { ok: true };
  });

export const addMember = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const role = clip(body.role, 20, "Role", true);
    if (!isRole(role) || role === "owner") throw new Error("Choose admin, member, or viewer.");
    return {
      organizationId: clip(body.organizationId, 80, "Workspace", true),
      email: clip(body.email, 200, "Email", true).toLowerCase(),
      role,
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");
    const users = await sql<{ id: string }>`
      select id from "user" where lower(email) = ${data.email} limit 1
    `;
    const existingUser = users[0]?.id;
    if (!existingUser) {
      const inviteId = id();
      const orgs = await sql<{ name: string }>`select name from organizations where id = ${data.organizationId} limit 1`;
      const { createInvitation, selectEmailProvider } = await import("@/lib/meridian/notifications/invite");
      const origin = process.env.BETTER_AUTH_URL?.trim() || "http://127.0.0.1:8080";
      const result = await createInvitation(sql, {
        id: inviteId,
        organizationId: data.organizationId,
        email: data.email,
        role: data.role,
        createdBy: context.userId,
        workspaceName: orgs[0]?.name ?? "",
        origin,
        provider: selectEmailProvider(),
      });
      await writeAudit(sql, {
        organizationId: data.organizationId,
        actorId: context.userId,
        action: "invite.created",
        objectType: "invite",
        objectId: inviteId,
        metadata: { email: data.email, role: data.role, delivery: result.status },
      });
      return { status: result.status, message: result.message };
    }
    const already = await sql<{ role: string }>`
      select role from memberships
      where organization_id = ${data.organizationId} and user_id = ${existingUser}
      limit 1
    `;
    if (already.length > 0) throw new Error("That person is already in this workspace.");
    const memberId = id();
    await sql`
      insert into memberships (id, organization_id, user_id, role)
      values (${memberId}, ${data.organizationId}, ${existingUser}, ${data.role})
    `;
    await sql`
      update invites set status = 'accepted'
      where organization_id = ${data.organizationId} and lower(email) = ${data.email} and status = 'recorded'
    `;
    await writeAudit(sql, {
      organizationId: data.organizationId,
      actorId: context.userId,
      action: "member.added",
      objectType: "membership",
      objectId: memberId,
      metadata: { email: data.email, role: data.role },
    });
    return { status: "added" as const, message: "Added to the workspace." };
  });

export const acceptInvite = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const token = clip(objectInput(input).token, 200, "Invitation", true);
    return { token };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const users = await sql<{ email: string }>`select email from "user" where id = ${context.userId} limit 1`;
    const email = users[0]?.email ?? "";
    if (!email) throw new Error("Your account has no email.");
    const { acceptInvitation } = await import("@/lib/meridian/notifications/invite");
    const accepted = await acceptInvitation(sql, { token: data.token, userId: context.userId, userEmail: email });
    await writeAudit(sql, {
      organizationId: accepted.organizationId,
      actorId: context.userId,
      action: "invite.accepted",
      objectType: "invite",
      objectId: accepted.organizationId,
      metadata: {},
    });
    return { status: "accepted" as const, message: "Invitation accepted." };
  });

export const changeMemberRole = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const roleRaw = clip(body.role, 20, "Role", true);
    if (roleRaw !== "remove" && !isRole(roleRaw)) throw new Error("Unknown role.");
    return {
      organizationId: clip(body.organizationId, 80, "Workspace", true),
      userId: clip(body.userId, 80, "Member", true),
      role: roleRaw,
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");
    const current = await sql<{ role: string }>`
      select role from memberships
      where organization_id = ${data.organizationId} and user_id = ${data.userId}
      limit 1
    `;
    const from = current[0]?.role;
    if (!from || !isRole(from)) throw new Error("That member is not in this workspace.");
    const owners = await sql<{ count: number }>`
      select count(*) from memberships
      where organization_id = ${data.organizationId} and role = 'owner'
    `;
    const ownerCount = Number(owners[0]?.count ?? 0);
    if (data.role !== "remove" && !isRole(data.role)) throw new Error("Unknown role.");
    const next: Role | null = data.role === "remove" ? null : data.role;
    if (nextOwnerCount(ownerCount, from, next) < 1) {
      throw new Error("A workspace needs at least one owner.");
    }
    if (next === null) {
      await sql`
        delete from memberships
        where organization_id = ${data.organizationId} and user_id = ${data.userId}
      `;
    } else {
      await sql`
        update memberships set role = ${next}
        where organization_id = ${data.organizationId} and user_id = ${data.userId}
      `;
    }
    await writeAudit(sql, {
      organizationId: data.organizationId,
      actorId: context.userId,
      action: next ? "member.role_changed" : "member.removed",
      objectType: "membership",
      objectId: data.userId,
      metadata: { from, to: next ?? "removed" },
    });
    return { ok: true };
  });

function identityInput(body: Record<string, unknown>, requireName: boolean) {
  return {
    name: clip(body.name, 120, "Brand name", requireName),
    description: clip(body.description, 2000, "Description"),
    category: clip(body.category, 120, "Category"),
    industry: clip(body.industry, 120, "Industry"),
    website: optionalUrl(body.website, "Website"),
    country: clip(body.country, 80, "Country"),
    sells: clip(body.sells, 500, "What you sell"),
    targetCustomers: clip(body.targetCustomers, 1000, "Target customer"),
  };
}

export const createBrand = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return {
      organizationId: clip(body.organizationId, 80, "Workspace", true),
      ...identityInput(body, true),
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "member");
    const brandId = id();
    await sql`
      insert into brands (
        id, organization_id, name, description, category, industry, website,
        country_market, sells, created_by
      ) values (
        ${brandId}, ${data.organizationId}, ${data.name}, ${data.description},
        ${data.category}, ${data.industry}, ${data.website}, ${data.country},
        ${data.sells}, ${context.userId}
      )
    `;
    const provenance: ProvenanceMap = {};
    if (data.targetCustomers) provenance.targetCustomers = "user_defined";
    const versionId = id();
    await sql`
      insert into brand_brains (
        brand_id, target_customers, provenance, version, updated_by
      ) values (
        ${brandId}, ${data.targetCustomers}, ${JSON.stringify(provenance)}, 1, ${context.userId}
      )
    `;
    await sql`
      insert into brand_brain_versions (id, brand_id, version, snapshot, note, created_by)
      values (
        ${versionId}, ${brandId}, 1,
        ${JSON.stringify({ identity: data, brain: { ...emptyBrain(), targetCustomers: data.targetCustomers }, provenance })},
        ${"Created with the brand"},
        ${context.userId}
      )
    `;
    await writeAudit(sql, {
      organizationId: data.organizationId,
      brandId,
      actorId: context.userId,
      action: "brand.created",
      objectType: "brand",
      objectId: brandId,
      metadata: { name: data.name },
    });
    return { id: brandId };
  });

export const updateBrand = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return {
      brandId: clip(body.brandId, 80, "Brand", true),
      ...identityInput(body, true),
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const located = await brandOrg(sql, data.brandId);
    if (!located) throw new Error("Brand not found.");
    await requireMembership(sql, context.userId, located.organizationId, "member");
    await sql`
      update brands set
        name = ${data.name},
        description = ${data.description},
        category = ${data.category},
        industry = ${data.industry},
        website = ${data.website},
        country_market = ${data.country},
        sells = ${data.sells},
        updated_at = now()
      where id = ${data.brandId} and deleted_at is null
    `;
    await writeAudit(sql, {
      organizationId: located.organizationId,
      brandId: data.brandId,
      actorId: context.userId,
      action: "brand.updated",
      objectType: "brand",
      objectId: data.brandId,
      metadata: { name: data.name },
    });
    return { ok: true };
  });

export const deleteBrand = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { brandId: clip(body.brandId, 80, "Brand", true) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const located = await brandOrg(sql, data.brandId);
    if (!located) throw new Error("Brand not found.");
    await requireMembership(sql, context.userId, located.organizationId, "admin");
    await sql`
      update brands set deleted_at = now(), updated_at = now()
      where id = ${data.brandId} and deleted_at is null
    `;
    await writeAudit(sql, {
      organizationId: located.organizationId,
      brandId: data.brandId,
      actorId: context.userId,
      action: "brand.deleted",
      objectType: "brand",
      objectId: data.brandId,
    });
    return { ok: true };
  });

export const getBrand = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { brandId: clip(body.brandId, 80, "Brand", true) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<BrandDetail> => {
    const sql = await getSql();
    const rows = await sql.query<Record<string, unknown>>(
      `select b.id, b.organization_id, b.name, b.description, b.category, b.industry,
              b.website, b.country_market, b.sells,
              ${BRAIN_COLUMNS}, br.automation_level, br.provenance, br.version
       from brands b
       left join brand_brains br on br.brand_id = b.id
       where b.id = $1 and b.deleted_at is null
       limit 1`,
      [data.brandId],
    );
    const row = rows[0];
    if (!row) throw new Error("Brand not found.");
    const organizationId = asText(row.organization_id);
    const access = await requireMembership(sql, context.userId, organizationId, "viewer");
    const { brain, provenance, version } = brainFromRow(row);
    const versions = await sql<{ version: number; note: string; created_at: unknown }>`
      select version, note, created_at from brand_brain_versions
      where brand_id = ${data.brandId}
      order by version desc
      limit 8
    `;
    const products = await sql<Record<string, unknown>>`
      select id, name, description, features, benefits, price, url, allowed_claims, prohibited_claims
      from products
      where brand_id = ${data.brandId} and deleted_at is null
      order by created_at desc
    `;
    return {
      identity: {
        id: asText(row.id),
        organizationId,
        name: asText(row.name),
        description: asText(row.description),
        category: asText(row.category),
        industry: asText(row.industry),
        website: asText(row.website),
        country: asText(row.country_market),
        sells: asText(row.sells),
        role: access.role,
      },
      brain,
      provenance,
      version,
      versions: versions.map((item) => ({
        version: Number(item.version),
        note: item.note,
        createdAt: asText(item.created_at),
      })),
      products: products.map((item) => ({
        id: asText(item.id),
        name: asText(item.name),
        description: asText(item.description),
        features: asText(item.features),
        benefits: asText(item.benefits),
        price: asText(item.price),
        url: asText(item.url),
        allowedClaims: asText(item.allowed_claims),
        prohibitedClaims: asText(item.prohibited_claims),
      })),
    };
  });

function readBrain(body: Record<string, unknown>): BrainValues {
  const brain = emptyBrain();
  for (const field of BRAIN_FIELDS) {
    brain[field.key] = clip(body[field.key], 4000, field.label);
  }
  const level = clip(body.automationLevel, 20, "Automation", false) || "manual";
  if (!isAutomationLevel(level)) throw new Error("Unknown automation level.");
  brain.automationLevel = level;
  return brain;
}

export const saveBrain = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { brandId: clip(body.brandId, 80, "Brand", true), brain: readBrain(body) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const located = await brandOrg(sql, data.brandId);
    if (!located) throw new Error("Brand not found.");
    await requireMembership(sql, context.userId, located.organizationId, "member");
    const currentRows = await sql.query<Record<string, unknown>>(
      `select ${BRAIN_FIELDS.map((field) => field.column).join(", ")}, automation_level, provenance, version
       from brand_brains where brand_id = $1 limit 1`,
      [data.brandId],
    );
    const current = brainFromRow(currentRows[0]);
    const provenance: ProvenanceMap = { ...current.provenance };
    for (const field of BRAIN_FIELDS) {
      if (data.brain[field.key] !== current.brain[field.key]) {
        provenance[field.key] = "user_defined" satisfies Provenance;
      }
    }
    const nextVersion = Math.max(current.version, 0) + 1;
    const b = data.brain;
    if (currentRows.length === 0) {
      await sql.query(
        `insert into brand_brains (
           brand_id, ${BRAIN_FIELDS.map((field) => field.column).join(", ")},
           automation_level, provenance, version, updated_by
         ) values (
           $1, ${BRAIN_FIELDS.map((_, index) => `$${index + 2}`).join(", ")},
           $${BRAIN_FIELDS.length + 2}, $${BRAIN_FIELDS.length + 3}, $${BRAIN_FIELDS.length + 4}, $${BRAIN_FIELDS.length + 5}
         )`,
        [
          data.brandId,
          ...BRAIN_FIELDS.map((field) => b[field.key]),
          b.automationLevel,
          JSON.stringify(provenance),
          nextVersion,
          context.userId,
        ],
      );
    } else {
      const assignments = BRAIN_FIELDS.map((field, index) => `${field.column} = $${index + 1}`);
      await sql.query(
        `update brand_brains set ${assignments.join(", ")},
           automation_level = $${BRAIN_FIELDS.length + 1},
           provenance = $${BRAIN_FIELDS.length + 2},
           version = $${BRAIN_FIELDS.length + 3},
           updated_by = $${BRAIN_FIELDS.length + 4},
           updated_at = now()
         where brand_id = $${BRAIN_FIELDS.length + 5}`,
        [
          ...BRAIN_FIELDS.map((field) => b[field.key]),
          b.automationLevel,
          JSON.stringify(provenance),
          nextVersion,
          context.userId,
          data.brandId,
        ],
      );
    }
    await sql`
      insert into brand_brain_versions (id, brand_id, version, snapshot, note, created_by)
      values (
        ${id()}, ${data.brandId}, ${nextVersion},
        ${JSON.stringify({ brain: b, provenance })},
        ${"Saved by a person"},
        ${context.userId}
      )
    `;
    await sql`update brands set updated_at = now() where id = ${data.brandId}`;
    await writeAudit(sql, {
      organizationId: located.organizationId,
      brandId: data.brandId,
      actorId: context.userId,
      action: "brand_brain.updated",
      objectType: "brand_brain",
      objectId: data.brandId,
      metadata: { version: String(nextVersion) },
    });
    return { version: nextVersion };
  });

function productInput(body: Record<string, unknown>) {
  return {
    name: clip(body.name, 160, "Product name", true),
    description: clip(body.description, 4000, "Description"),
    features: clip(body.features, 4000, "Features"),
    benefits: clip(body.benefits, 4000, "Benefits"),
    price: clip(body.price, 80, "Price"),
    url: optionalUrl(body.url, "Product URL"),
    allowedClaims: clip(body.allowedClaims, 2000, "Allowed claims"),
    prohibitedClaims: clip(body.prohibitedClaims, 2000, "Prohibited claims"),
  };
}

export const saveProduct = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const productId = clip(body.productId, 80, "Product");
    return {
      brandId: clip(body.brandId, 80, "Brand", true),
      productId,
      product: productInput(body),
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const located = await brandOrg(sql, data.brandId);
    if (!located) throw new Error("Brand not found.");
    await requireMembership(sql, context.userId, located.organizationId, "member");
    const p = data.product;
    let productId = data.productId;
    if (productId) {
      const owned = await sql<{ id: string }>`
        select id from products
        where id = ${productId} and brand_id = ${data.brandId} and deleted_at is null
        limit 1
      `;
      if (owned.length === 0) throw new Error("Product not found.");
      await sql`
        update products set
          name = ${p.name}, description = ${p.description}, features = ${p.features},
          benefits = ${p.benefits}, price = ${p.price}, url = ${p.url},
          allowed_claims = ${p.allowedClaims}, prohibited_claims = ${p.prohibitedClaims},
          updated_at = now()
        where id = ${productId}
      `;
    } else {
      productId = id();
      await sql`
        insert into products (
          id, brand_id, name, description, features, benefits, price, url,
          allowed_claims, prohibited_claims, created_by
        ) values (
          ${productId}, ${data.brandId}, ${p.name}, ${p.description}, ${p.features},
          ${p.benefits}, ${p.price}, ${p.url}, ${p.allowedClaims}, ${p.prohibitedClaims},
          ${context.userId}
        )
      `;
    }
    await writeAudit(sql, {
      organizationId: located.organizationId,
      brandId: data.brandId,
      actorId: context.userId,
      action: data.productId ? "product.updated" : "product.created",
      objectType: "product",
      objectId: productId,
      metadata: { name: p.name },
    });
    return { id: productId };
  });

export const deleteProduct = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return {
      brandId: clip(body.brandId, 80, "Brand", true),
      productId: clip(body.productId, 80, "Product", true),
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const located = await brandOrg(sql, data.brandId);
    if (!located) throw new Error("Brand not found.");
    await requireMembership(sql, context.userId, located.organizationId, "member");
    const updated = await sql<{ id: string }>`
      update products set deleted_at = now(), updated_at = now()
      where id = ${data.productId} and brand_id = ${data.brandId} and deleted_at is null
      returning id
    `;
    if (updated.length === 0) throw new Error("Product not found.");
    await writeAudit(sql, {
      organizationId: located.organizationId,
      brandId: data.brandId,
      actorId: context.userId,
      action: "product.deleted",
      objectType: "product",
      objectId: data.productId,
    });
    return { ok: true };
  });

export const AUTOMATION_CHOICES = AUTOMATION_LEVELS;
export type { AutomationLevel, BrainKey };
