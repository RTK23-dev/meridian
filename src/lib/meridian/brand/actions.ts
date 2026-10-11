import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import {
  AUTOMATION_LEVELS,
  emptyBrain,
  type AutomationLevel,
  type BrainKey,
  type BrainSectionId,
  type BrainValues,
  type ProvenanceMap,
} from "@/lib/meridian/brain";
import { brandIdentitySchema } from "@/lib/meridian/schemas/brand";
import { type Role } from "@/lib/meridian/access";
import {
  parseBrainChanges,
  parseBrainSection,
  readBrainProgress,
  recordBrainSection,
  saveBrainChanges,
  type BrainProgress,
} from "./brain-store.ts";
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
  /** Where the person left off in the brain. The brain screen opens at this section. */
  progress: BrainProgress;
};

export const AUTOMATION_CHOICES = AUTOMATION_LEVELS;
export type { AutomationLevel, BrainKey, BrainProgress, BrainSectionId };

function identityInput(body: Record<string, unknown>, requireName: boolean) {
  const candidate = { ...body };
  for (const key of ["description", "category", "industry", "website", "country", "sells", "targetCustomers"] as const) {
    if (candidate[key] == null) candidate[key] = "";
  }
  const parsed = brandIdentitySchema.parse(candidate);
  if (requireName && !parsed.name) throw new Error("Brand name is required.");
  return parsed;
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
      progress: await readBrainProgress(sql, data.brandId),
    };
  });

/**
 * Saves the brain. `changes` holds only the fields the person edited, and the server writes only those. A field that is not
 * sent is never written, so an open form cannot replace a value someone else saved in the meantime.
 * autosave is true only for the editor's background save. The Save button sends no flag, so it always appends a version.
 */
export const saveBrain = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return {
      brandId: clip(body.brandId, 80, "Brand", true),
      changes: parseBrainChanges(body.changes),
      autosave: body.autosave === true,
      section: parseBrainSection(body.section),
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const saved = await saveBrainChanges(sql, {
      brandId: data.brandId,
      actorId: context.userId,
      changes: data.changes,
      autosave: data.autosave,
      section: data.section,
    });
    await writeAudit(sql, {
      organizationId: saved.organizationId,
      brandId: data.brandId,
      actorId: context.userId,
      action: "brand_brain.updated",
      objectType: "brand_brain",
      objectId: data.brandId,
      metadata: { version: String(saved.version) },
    });
    return { version: saved.version, brain: saved.brain };
  });

/** Records the section the person opened, so the brain opens there next time. A viewer is refused, as on every brain write. */
export const recordBrainProgress = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { brandId: clip(body.brandId, 80, "Brand", true), section: parseBrainSection(body.section) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const progress = await recordBrainSection(sql, { brandId: data.brandId, actorId: context.userId, section: data.section });
    return { section: progress.section };
  });
