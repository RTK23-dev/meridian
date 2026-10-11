import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { storedPageWithText } from "./source-documents.ts";

async function tenant(sql: Sql) {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `org-srcdoc-${suffix}`;
  const brandId = `brand-srcdoc-${suffix}`;
  const otherBrandId = `brand-srcdoc-b-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, 'test-user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${otherBrandId}, ${organizationId}, ${otherBrandId}, 'test-user')`;
  return { organizationId, brandId, otherBrandId };
}

test("identical stored text for a brand is found, so the page is not stored a second time", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql);
  const documentId = `doc_${randomUUID()}`;
  await sql`
    insert into source_documents (id, organization_id, brand_id, url, status, excerpt, created_by)
    values (${documentId}, ${organizationId}, ${brandId}, 'https://shop.example/about', 'stored', 'We make mesh sponges.', 'test-user')
  `;

  assert.equal(
    await storedPageWithText(sql, { organizationId, brandId }, "We make mesh sponges."),
    documentId,
  );
});

test("different text, a failed document, or another brand's copy does not match", async () => {
  const sql = await getSql();
  const { organizationId, brandId, otherBrandId } = await tenant(sql);
  await sql`
    insert into source_documents (id, organization_id, brand_id, url, status, excerpt, created_by)
    values (${`doc_${randomUUID()}`}, ${organizationId}, ${brandId}, 'https://shop.example/a', 'stored', 'Original text.', 'test-user')
  `;
  await sql`
    insert into source_documents (id, organization_id, brand_id, url, status, error, excerpt, created_by)
    values (${`doc_${randomUUID()}`}, ${organizationId}, ${brandId}, 'https://shop.example/b', 'failed', 'timeout', 'Failed text.', 'test-user')
  `;

  assert.equal(await storedPageWithText(sql, { organizationId, brandId }, "Changed text."), null, "changed text is a new record");
  assert.equal(await storedPageWithText(sql, { organizationId, brandId }, "Failed text."), null, "a failed read stores no text to match");
  assert.equal(await storedPageWithText(sql, { organizationId, brandId: otherBrandId }, "Original text."), null, "dedupe is per brand");
});
