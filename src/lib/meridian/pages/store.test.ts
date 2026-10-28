import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { studioTenant } from "../../../test-support/lib/meridian/testing/durable-image-fixtures.ts";
import { parseNewThemePage, parseThemePageFields } from "./model.ts";
import {
  archiveThemePage,
  createThemePage,
  getThemePage,
  listThemePages,
  runPageProblem,
  trialDefaultForRunPage,
  updateThemePage,
} from "./store.ts";

// The store runs on PGlite (the default database in tests). Every fixture gets its own workspace, so the tests do not share rows.

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function seedAccount(sql: Sql, organizationId: string, brandId: string, platform: string): Promise<string> {
  const id = `acct-${unique()}`;
  await sql`
    insert into platform_accounts (id, organization_id, brand_id, platform, external_account_id, name)
    values (${id}, ${organizationId}, ${brandId}, ${platform}, ${`ext-${id}`}, 'Fixture account')
  `;
  return id;
}

async function seedKit(sql: Sql, organizationId: string, kind: string, kitId: string): Promise<void> {
  await sql`
    insert into engine_kits (id, organization_id, kind, kit_id, content_hash, body)
    values (${`kit-${unique()}`}, ${organizationId}, ${kind}, ${kitId}, ${`sha256:${"0".repeat(64)}`}, '{}')
  `;
}

function fieldsOf(input: unknown) {
  const parsed = parseNewThemePage(input);
  if (!parsed.ok) throw new Error(`fixture page refused: ${parsed.error}`);
  return parsed.value;
}

test("a page is created with its account and kits, listed with them, and retired by archiving", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, `pages-${unique()}`);
  const scope = { organizationId: tenant.organizationId, brandId: tenant.brandId };
  const accountId = await seedAccount(sql, scope.organizationId, scope.brandId, "instagram");
  await seedKit(sql, scope.organizationId, "style", "style-1");
  await seedKit(sql, scope.organizationId, "persona", "persona-1");

  const id = await createThemePage(
    sql,
    scope,
    fieldsOf({
      name: "Kitchen",
      platform: "instagram",
      platformAccountId: accountId,
      styleKitId: "style-1",
      personaKitId: "persona-1",
      postingTimeZone: "Europe/London",
      postingTimes: { mon: ["09:00"] },
      trialFirst: true,
      trialGraduation: "MANUAL",
    }),
    tenant.userId,
  );

  const listed = (await listThemePages(sql, scope)).find((item) => item.id === id);
  assert.ok(listed, "the new page is listed");
  assert.equal(listed.platformAccount?.id, accountId);
  assert.equal(listed.styleKitId, "style-1");
  assert.equal(listed.voiceKitId, null, "a kit the page does not set stays unknown");
  assert.deepEqual(listed.postingTimes, { mon: ["09:00"] });
  assert.deepEqual(await trialDefaultForRunPage(sql, scope, id), { graduationStrategy: "MANUAL" });
  assert.equal(await runPageProblem(sql, scope, id), null);

  await archiveThemePage(sql, scope, id, tenant.userId);
  assert.equal((await listThemePages(sql, scope)).some((item) => item.id === id), false, "an archived page is not listed");
  assert.match(await runPageProblem(sql, scope, id) ?? "", /archived/, "an archived page cannot start a run");
  assert.equal(await trialDefaultForRunPage(sql, scope, id), null, "an archived page gives no trial default");
});

test("a page that names another workspace's account, a missing kit, or the wrong platform is refused, and nothing is written", async () => {
  const sql = await getSql();
  const home = await studioTenant(sql, `pages-home-${unique()}`);
  const other = await studioTenant(sql, `pages-other-${unique()}`);
  const scope = { organizationId: home.organizationId, brandId: home.brandId };
  const foreignAccount = await seedAccount(sql, other.organizationId, other.brandId, "instagram");
  const facebookAccount = await seedAccount(sql, scope.organizationId, scope.brandId, "facebook");
  const before = (await listThemePages(sql, scope)).length;

  await assert.rejects(
    createThemePage(sql, scope, fieldsOf({ name: "Foreign", platform: "instagram", platformAccountId: foreignAccount }), home.userId),
    /not an account of this brand/,
  );
  await assert.rejects(
    createThemePage(sql, scope, fieldsOf({ name: "Missing kit", platform: "instagram", styleKitId: "style-404" }), home.userId),
    /style kit style-404 is not in this workspace/,
  );
  await assert.rejects(
    createThemePage(sql, scope, fieldsOf({ name: "Wrong platform", platform: "instagram", platformAccountId: facebookAccount }), home.userId),
    /is a facebook account, and this page is instagram/,
  );
  assert.equal((await listThemePages(sql, scope)).length, before, "a refused page is not written");
});

test("an edit that breaks a page's rules is refused, and the page keeps its stored fields", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, `pages-edit-${unique()}`);
  const scope = { organizationId: tenant.organizationId, brandId: tenant.brandId };
  const id = await createThemePage(sql, scope, fieldsOf({ name: "Plain", platform: "youtube" }), tenant.userId);

  const schedule = parseThemePageFields({ postingTimes: { mon: ["09:00"] } });
  if (!schedule.ok) throw new Error("fixture");
  await assert.rejects(updateThemePage(sql, scope, id, schedule.value, tenant.userId), /needs a time zone/);

  const trial = parseThemePageFields({ trialFirst: true });
  if (!trial.ok) throw new Error("fixture");
  await assert.rejects(updateThemePage(sql, scope, id, trial.value, tenant.userId), /needs a graduation strategy/);

  const stored = await getThemePage(sql, scope, id);
  assert.equal(stored?.postingTimes, null, "the refused schedule was not saved");
  assert.equal(stored?.trialFirst, false, "the refused trial was not saved");

  const valid = parseThemePageFields({ postingTimeZone: "America/New_York", postingTimes: { fri: ["18:30"] }, status: "paused" });
  if (!valid.ok) throw new Error("fixture");
  await updateThemePage(sql, scope, id, valid.value, tenant.userId);
  const saved = await getThemePage(sql, scope, id);
  assert.equal(saved?.postingTimeZone, "America/New_York");
  assert.deepEqual(saved?.postingTimes, { fri: ["18:30"] });
  assert.equal(saved?.status, "paused");
  assert.match(await runPageProblem(sql, scope, id) ?? "", /paused/, "a paused page cannot start a run");
});

test("a page is readable only inside its own workspace and brand", async () => {
  const sql = await getSql();
  const home = await studioTenant(sql, `pages-scope-${unique()}`);
  const other = await studioTenant(sql, `pages-scope-other-${unique()}`);
  const scope = { organizationId: home.organizationId, brandId: home.brandId };
  const id = await createThemePage(sql, scope, fieldsOf({ name: "Private", platform: "tiktok" }), home.userId);

  assert.ok(await getThemePage(sql, scope, id));
  assert.equal(await getThemePage(sql, { organizationId: other.organizationId, brandId: other.brandId }, id), null);
  assert.equal(await getThemePage(sql, { organizationId: home.organizationId, brandId: other.brandId }, id), null, "a page is not read through another brand");
  assert.match(await runPageProblem(sql, { organizationId: other.organizationId, brandId: other.brandId }, id) ?? "", /not a page of this brand/);
});
