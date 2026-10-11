/**
 * Accepting a brain suggestion goes through the brand brain save path. An accepted suggestion changes only its own field, writes
 * one version row like any other save, and records the field's provenance. A suggestion whose value the brain already holds
 * changes nothing. A caller who cannot write the brain changes nothing, and the suggestion stays pending.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { openTestBackends, type TestBackend } from "../credentials/test-databases.ts";
import type { Sql } from "../learning/store.ts";
import { saveBrainChanges } from "../brand/brain-store.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { acceptBrainSuggestion } from "./suggestion-accept.ts";

const backends: TestBackend[] = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

async function brainRow(sql: Sql, brandId: string) {
  const rows = await sql.query<Record<string, unknown>>(
    "select mission, positioning, provenance, version from brand_brains where brand_id = $1",
    [brandId],
  );
  const row = rows[0];
  const provenance = typeof row?.provenance === "string" ? JSON.parse(row.provenance) as Record<string, string> : (row?.provenance ?? {}) as Record<string, string>;
  return { mission: String(row?.mission ?? ""), positioning: String(row?.positioning ?? ""), provenance, version: Number(row?.version ?? 0) };
}

async function versionCount(sql: Sql, brandId: string): Promise<number> {
  const rows = await sql<{ n: number }>`select count(*)::int as n from brand_brain_versions where brand_id = ${brandId}`;
  return Number(rows[0]?.n ?? 0);
}

async function suggestion(sql: Sql, input: { organizationId: string; brandId: string; field: string; value: string }): Promise<string> {
  const id = `sugg-${randomUUID()}`;
  await sql`
    insert into brain_suggestions (id, organization_id, brand_id, field_key, proposed_value, status, provider, model)
    values (${id}, ${input.organizationId}, ${input.brandId}, ${input.field}, ${input.value}, 'pending', 'test', 'test')
  `;
  return id;
}

async function statusOf(sql: Sql, id: string): Promise<string> {
  const rows = await sql<{ status: string }>`select status from brain_suggestions where id = ${id}`;
  return rows[0]?.status ?? "";
}

for (const { name, sql } of backends) {
  test(`[${name}] an accepted suggestion is a change-only save: it writes its field, one version row, and the field's provenance`, async () => {
    const tenant = await studioTenant(sql, `accept-save-${name}`);
    await saveBrainChanges(sql, { brandId: tenant.brandId, actorId: tenant.userId, changes: { mission: "Old mission", positioning: "Keep this positioning" }, autosave: false, section: null });
    const before = await brainRow(sql, tenant.brandId);
    const versionsBefore = await versionCount(sql, tenant.brandId);

    const id = await suggestion(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, field: "mission", value: "New mission" });
    const result = await acceptBrainSuggestion(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, suggestionId: id, actorId: tenant.userId });

    assert.deepEqual(result, { field: "mission", changed: true, version: before.version + 1 });
    const after = await brainRow(sql, tenant.brandId);
    assert.equal(after.mission, "New mission");
    assert.equal(after.positioning, "Keep this positioning", "a field the suggestion does not name is not written");
    assert.equal(after.provenance.mission, "user_defined", "the accepted field is recorded as the person's");
    assert.equal(after.version, before.version + 1);
    assert.equal(await versionCount(sql, tenant.brandId), versionsBefore + 1, "one version row, like any other save");
    const latest = await sql<{ note: string; snapshot: string }>`
      select note, snapshot from brand_brain_versions where brand_id = ${tenant.brandId} order by version desc limit 1
    `;
    assert.equal(latest[0]?.note, "Saved by a person");
    assert.match(String(latest[0]?.snapshot), /New mission/);
    assert.equal(await statusOf(sql, id), "accepted");
  });

  test(`[${name}] a suggestion whose value the brain already holds changes nothing, and writes no version`, async () => {
    const tenant = await studioTenant(sql, `accept-same-${name}`);
    await saveBrainChanges(sql, { brandId: tenant.brandId, actorId: tenant.userId, changes: { mission: "Same mission" }, autosave: false, section: null });
    const before = await brainRow(sql, tenant.brandId);
    const versionsBefore = await versionCount(sql, tenant.brandId);

    const id = await suggestion(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, field: "mission", value: "Same mission" });
    const result = await acceptBrainSuggestion(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, suggestionId: id, actorId: tenant.userId });

    assert.deepEqual(result, { field: "mission", changed: false, version: null });
    assert.deepEqual(await brainRow(sql, tenant.brandId), before, "the brain is untouched");
    assert.equal(await versionCount(sql, tenant.brandId), versionsBefore);
    assert.equal(await statusOf(sql, id), "accepted");
  });

  test(`[${name}] a caller who cannot write the brain changes nothing, and the suggestion stays pending`, async () => {
    const tenant = await studioTenant(sql, `accept-viewer-${name}`);
    await saveBrainChanges(sql, { brandId: tenant.brandId, actorId: tenant.userId, changes: { mission: "Protected" }, autosave: false, section: null });
    await sql`update memberships set role = 'viewer' where organization_id = ${tenant.organizationId} and user_id = ${tenant.userId}`;
    const before = await brainRow(sql, tenant.brandId);
    const versionsBefore = await versionCount(sql, tenant.brandId);

    const id = await suggestion(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, field: "mission", value: "Overwrite" });
    await assert.rejects(
      acceptBrainSuggestion(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, suggestionId: id, actorId: tenant.userId }),
      /role|permission|not available|member/i,
    );

    assert.deepEqual(await brainRow(sql, tenant.brandId), before);
    assert.equal(await versionCount(sql, tenant.brandId), versionsBefore);
    assert.equal(await statusOf(sql, id), "pending");
  });

  test(`[${name}] a suggestion that is not pending, or names an unknown field, is refused`, async () => {
    const tenant = await studioTenant(sql, `accept-refuse-${name}`);
    const dismissed = await suggestion(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, field: "mission", value: "x" });
    await sql`update brain_suggestions set status = 'dismissed' where id = ${dismissed}`;
    await assert.rejects(
      acceptBrainSuggestion(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, suggestionId: dismissed, actorId: tenant.userId }),
      /not pending/,
    );

    const unknown = await suggestion(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, field: "not_a_field", value: "x" });
    await assert.rejects(
      acceptBrainSuggestion(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, suggestionId: unknown, actorId: tenant.userId }),
      /Unknown brain field/,
    );
    assert.equal(await statusOf(sql, unknown), "pending");
  });
}
