import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { productFieldsSchema } from "@/lib/meridian/schemas/product";
import {
  id,
  clip,
  objectInput,
  requireMembership,
  brandOrg,
  writeAudit,
} from "../api-shared";

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

export const saveProduct = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const productId = clip(body.productId, 80, "Product");
    return {
      brandId: clip(body.brandId, 80, "Brand", true),
      productId,
      product: productFieldsSchema.parse({
        ...body,
        description: body.description ?? "",
        features: body.features ?? "",
        benefits: body.benefits ?? "",
        price: body.price ?? "",
        url: body.url ?? "",
        allowedClaims: body.allowedClaims ?? "",
        prohibitedClaims: body.prohibitedClaims ?? "",
      }),
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
