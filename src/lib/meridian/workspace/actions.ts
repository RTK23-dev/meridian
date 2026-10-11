import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, type Sql } from "@/lib/db";
import { isRole, nextOwnerCount, type Role } from "@/lib/meridian/access";
import { slugify } from "@/lib/meridian/brain";
import { WEIGHT_KEYS } from "@/lib/meridian/scoring";
import { loadWorkspaceBrands } from "./brands-listing";
import { memberInviteSchema, scoringWeightsSchema, workspaceNameSchema } from "@/lib/meridian/schemas/settings";
import {
  id,
  asText,
  asCount,
  asRecord,
  clip,
  objectInput,
  requireMembership,
  writeAudit,
  weightsFromRow,
} from "../api-shared";

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
  /** The id /api/assets/<id> serves for the brand's logo. Null when no logo is stored. */
  logoAssetId: string | null;
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
  active: (OrgSummary & { weights: ReturnType<typeof weightsFromRow> }) | null;
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
    const brands = await loadWorkspaceBrands(sql, activeOrg.id);
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

export const createOrganization = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return workspaceNameSchema.parse(body);
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
      ...workspaceNameSchema.parse(body),
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
    const weights = scoringWeightsSchema.parse(Object.fromEntries(WEIGHT_KEYS.map((key) => [key, String(source[key] ?? "")] )));
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
    const invite = memberInviteSchema.parse({ email: body.email, role: body.role });
    return {
      organizationId: clip(body.organizationId, 80, "Workspace", true),
      ...invite,
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
