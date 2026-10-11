import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PAGE_LIMIT_MESSAGE, parsePageLimit } from "./page-limit.ts";
import { getWorkspaceProviderSettings, saveWorkspaceProviderConfig } from "./provider-config.ts";
import { openTestBackends } from "../credentials/test-databases.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";

test("a page limit is a whole number of pages, 1 or more", () => {
  assert.equal(parsePageLimit(1), 1);
  assert.equal(parsePageLimit("50"), 50);
  assert.equal(parsePageLimit(" 7 "), 7);
  assert.equal(parsePageLimit(0), null, "zero pages is not a limit");
  assert.equal(parsePageLimit(-3), null, "a negative limit is refused");
  assert.equal(parsePageLimit("-3"), null);
  assert.equal(parsePageLimit(2.5), null, "a fraction is refused");
  assert.equal(parsePageLimit("2.5"), null);
  assert.equal(parsePageLimit(""), null);
  assert.equal(parsePageLimit("   "), null);
  assert.equal(parsePageLimit("ten"), null);
  assert.equal(parsePageLimit(Number.POSITIVE_INFINITY), null);
  assert.equal(parsePageLimit(undefined), null);
});

test("the settings form uses the same page-limit rule and message as the server", () => {
  const clientSchema = readFileSync(fileURLToPath(new URL("../../../components/forms/client-schemas.ts", import.meta.url)), "utf8");
  assert.match(clientSchema, /parsePageLimit\(value\) !== null, PAGE_LIMIT_MESSAGE/);
  assert.doesNotMatch(clientSchema, /Number\.isFinite\(Number\(value\)\)/, "the form no longer accepts any finite number");
  assert.match(PAGE_LIMIT_MESSAGE, /whole number/);
});

// Used only by this test process: the vault encrypts saved values with this master key.
process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-page-limit";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

for (const { name, sql } of backends) {
  test(`[${name}] the server refuses a fractional, negative, zero or blank page limit and stores nothing`, async () => {
    const tenant = await studioTenant(sql, `page-limit-refuse-${name}`);
    for (const bad of [2.5, -4, 0, "", "many"]) {
      await assert.rejects(
        saveWorkspaceProviderConfig(sql, {
          organizationId: tenant.organizationId,
          actorId: tenant.userId,
          category: "sources",
          settings: { maxPages: bad },
        }),
        new RegExp(PAGE_LIMIT_MESSAGE.replace(/[.]/g, "\\.")),
        `refused: ${JSON.stringify(bad)}`,
      );
    }
    const rows = await sql<{ count: number }>`
      select count(*)::int as count from credential_vault
      where organization_id = ${tenant.organizationId} and credential_type = 'provider_config:sources'
    `;
    assert.equal(Number(rows[0]?.count ?? 0), 0, "a refused save writes no entry");
  });

  test(`[${name}] a valid page limit is stored as a whole number and read back as that number`, async () => {
    const tenant = await studioTenant(sql, `page-limit-store-${name}`);
    await saveWorkspaceProviderConfig(sql, {
      organizationId: tenant.organizationId,
      actorId: tenant.userId,
      category: "sources",
      settings: { maxPages: "7" },
    });
    const summary = await getWorkspaceProviderSettings(sql, tenant.organizationId);
    assert.equal(summary.sources.settings.maxPagesPerRun, 7);
  });
}
