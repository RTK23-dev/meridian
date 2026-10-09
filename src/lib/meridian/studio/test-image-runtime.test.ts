import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { getStudioSession } from "./session.server.ts";

/**
 * M4 regression: the studio screen may offer the placeholder "Test image" provider only in
 * TestingRuntime. The server decides this and sends the flag with the session payload.
 */

async function withRuntime<T>(
  runtime: { NODE_ENV: string | undefined; MERIDIAN_TESTING_RUNTIME: string | undefined },
  run: () => Promise<T>,
): Promise<T> {
  const prior = { NODE_ENV: process.env.NODE_ENV, MERIDIAN_TESTING_RUNTIME: process.env.MERIDIAN_TESTING_RUNTIME };
  const apply = (name: "NODE_ENV" | "MERIDIAN_TESTING_RUNTIME", value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  apply("NODE_ENV", runtime.NODE_ENV);
  apply("MERIDIAN_TESTING_RUNTIME", runtime.MERIDIAN_TESTING_RUNTIME);
  try {
    return await run();
  } finally {
    apply("NODE_ENV", prior.NODE_ENV);
    apply("MERIDIAN_TESTING_RUNTIME", prior.MERIDIAN_TESTING_RUNTIME);
  }
}

test("the studio session offers the test image provider only in TestingRuntime", async () => {
  const sql = await getSql();
  const suffix = `test-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `user-${suffix}`;
  const organizationId = `org-${suffix}`;
  const brandId = `brand-${suffix}`;
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, 'Fixture User', ${`${userId}@fixture.example`}, true)`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, ${userId})`;
  await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${suffix}`}, ${organizationId}, ${userId}, 'member')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, ${userId})`;

  const production = await withRuntime({ NODE_ENV: "production", MERIDIAN_TESTING_RUNTIME: undefined }, () =>
    getStudioSession(userId, { brandId }),
  );
  assert.equal(production.testImageAllowed, false, "production must not offer the placeholder image provider");

  const testing = await withRuntime({ NODE_ENV: "development", MERIDIAN_TESTING_RUNTIME: "true" }, () =>
    getStudioSession(userId, { brandId }),
  );
  assert.equal(testing.testImageAllowed, true, "TestingRuntime keeps the placeholder image provider available");
});
