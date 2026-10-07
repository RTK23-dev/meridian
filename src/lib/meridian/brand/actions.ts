import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import {
  AUTOMATION_LEVELS,
  BRAIN_FIELDS,
  emptyBrain,
  type AutomationLevel,
  type BrainKey,
  type BrainValues,
  type Provenance,
  type ProvenanceMap,
} from "@/lib/meridian/brain";
import { brandIdentitySchema } from "@/lib/meridian/schemas/brand";
import { brainValuesSchema } from "@/lib/meridian/schemas/brain";
import { type Role } from "@/lib/meridian/access";
import {
  id,
  asText,
  clip,
  objectInput,
  requireMembership,
  brandOrg,
  writeAudit,
  brainFromRow,
  BRAIN_COLUMNS,
} from "../api-shared";
import type { ProductRow } from "../products/actions";

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

export type BrandDetail = {
  identity: BrandIdentity;
  brain: BrainValues;
  provenance: ProvenanceMap;
  version: number;
  versions: BrainVersion[];
  products: ProductRow[];
};

export const AUTOMATION_CHOICES = AUTOMATION_LEVELS;
export type { AutomationLevel, BrainKey };

function identityInput(body: Record<string, unknown>, requireName: boolean) {
  const candidate = { ...body };
  for (const key of ["description", "category", "industry", "website", "country", "sells", "targetCustomers"] as const) {
    if (candidate[key] == null) candidate[key] = "";
  }
  const parsed = brandIdentitySchema.parse(candidate);
  if (requireName && !parsed.name) throw new Error("Brand name is required.");
  return parsed;
}

function readBrain(body: Record<string, unknown>): BrainValues {
  const candidate = { ...emptyBrain(), ...body };
  for (const field of BRAIN_FIELDS) {
    if (candidate[field.key] == null) candidate[field.key] = "";
  }
  if (candidate.automationLevel == null) candidate.automationLevel = "manual";
  return brainValuesSchema.parse(candidate);
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
