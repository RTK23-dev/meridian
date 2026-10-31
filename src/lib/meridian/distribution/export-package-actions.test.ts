import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import { studioTenant } from "../../../test-support/lib/meridian/testing/produce-fixtures.ts";
import { registerAliases } from "../../../test-support/register-aliases.ts";

// The server module uses the "@/" alias, so the alias hook is registered before it is first loaded.
await registerAliases();
const { checkExport } = await import("./export-package-actions.ts");

// A creative Meridian made is treated as generated, so its export package is blocked until the disclosures exist (export-gate.ts).
// These tests run on PGlite, with the workspace and the creative written directly.

test("a generated creative in the brand is checked, blocked, and its package is not returned", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "export-check-blocked");
  const creativeId = `cr-${randomUUID()}`;
  await sql`
    insert into creative_records (id, organization_id, brand_id, origin, title, status, created_by)
    values (${creativeId}, ${tenant.organizationId}, ${tenant.brandId}, 'generated', 'Launch cut', 'approved', ${tenant.userId})
  `;
  const check = await checkExport(sql, tenant.userId, { organizationId: tenant.organizationId, brandId: tenant.brandId, creativeId });
  assert.equal(check.passed, false);
  assert.equal(check.package, null, "a blocked creative's files and copy are not returned");
  assert.equal(check.reasons.length, 3, "the three disclosures that are missing are each named");
});

test("a creative from another brand is refused as not in this brand", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "export-check-brand");
  const other = await studioTenant(sql, "export-check-other");
  const creativeId = `cr-${randomUUID()}`;
  await sql`
    insert into creative_records (id, organization_id, brand_id, origin, title, status, created_by)
    values (${creativeId}, ${other.organizationId}, ${other.brandId}, 'generated', 'Other cut', 'approved', ${other.userId})
  `;
  const check = await checkExport(sql, tenant.userId, { organizationId: tenant.organizationId, brandId: tenant.brandId, creativeId });
  assert.equal(check.passed, false);
  assert.deepEqual(check.reasons, ["This creative is not in this brand."]);
});

test("a person who is not a member of the workspace is refused", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "export-check-outsider");
  const outsider = await studioTenant(sql, "export-check-outsider-other");
  await assert.rejects(
    checkExport(sql, outsider.userId, { organizationId: tenant.organizationId, brandId: tenant.brandId, creativeId: "any" }),
    /not available to you/,
  );
});
