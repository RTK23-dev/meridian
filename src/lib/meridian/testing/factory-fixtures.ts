/**
 * Shared fixtures for the Content Factory tests. A test database runs every migration in filename order on PGlite, so the
 * schema under test is the schema that ships. Nothing here calls a provider.
 */

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "../learning/store.ts";
import type { ExecutableJob } from "../jobs/execute.ts";

export const FACTORY_TEST_ORG = "org-factory";
export const FACTORY_TEST_BRAND = "brand-factory";
export const FACTORY_TEST_RUN = "run-factory";

/** Creates a PGlite database with every migration applied, behind the same tag the server code uses. */
export async function makeFactoryTestSql(): Promise<Sql> {
  const db = new PGlite({ extensions: { vector } });
  await db.waitReady;
  const dir = join(process.cwd(), "migrations");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  await db.exec("create table if not exists _migrations (name text primary key)");
  for (const name of names) {
    await db.exec(await readFile(join(dir, name), "utf8"));
  }
  const sql = (async <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? "";
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1] ?? ""}`;
    const result = await db.query<T>(text, values);
    return result.rows;
  }) as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await db.query<T>(text, params)).rows;
  return sql;
}

/** A workspace, a brand and one Factory run with the given stored settings. The run starts queued, as startFactoryRun leaves it. */
export async function seedFactoryRun(
  sql: Sql,
  input: { settings: Record<string, unknown>; level: number; niche?: string; website?: string; country?: string },
): Promise<void> {
  await sql`insert into organizations (id, name, slug, created_by) values (${FACTORY_TEST_ORG}, 'Factory test', 'factory-test', 'user-1')`;
  await sql`
    insert into brands (id, organization_id, name, created_by, website, country_market)
    values (${FACTORY_TEST_BRAND}, ${FACTORY_TEST_ORG}, 'Brand', 'user-1', ${input.website ?? ""}, ${input.country ?? ""})
  `;
  await sql`
    insert into factory_runs (id, organization_id, brand_id, niche, level, status, current_stage, created_by, settings)
    values (${FACTORY_TEST_RUN}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${input.niche ?? "skincare"}, ${input.level},
      'queued', 'factory.discover', 'user-1', ${JSON.stringify(input.settings)})
  `;
}

/** The job the durable queue would hand the worker for one Factory stage of the test run. */
export function factoryJob(stage: string, id = `job-${stage}`): ExecutableJob {
  return {
    id,
    organization_id: FACTORY_TEST_ORG,
    brand_id: FACTORY_TEST_BRAND,
    job_type: stage,
    payload: JSON.stringify({ runId: FACTORY_TEST_RUN }),
    attempts: 0,
    max_attempts: 3,
  };
}

/** The run row's status, stage and reason, as the Factory board reads them. */
export async function factoryRunRow(sql: Sql): Promise<{ status: string; current_stage: string; error: string }> {
  const rows = await sql<{ status: string; current_stage: string; error: string }>`
    select status, current_stage, error from factory_runs where id = ${FACTORY_TEST_RUN}
  `;
  if (!rows[0]) throw new Error("The test run is missing.");
  return rows[0];
}
