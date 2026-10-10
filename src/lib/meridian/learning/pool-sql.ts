/**
 * The pool-backed and transaction-backed `Sql`, shared by the web server, the worker and the tests. This module has no web
 * imports, so the worker can use it without loading the web database module. `begin` pins one connection: BEGIN, the block,
 * then COMMIT, or ROLLBACK when the block throws. A connection whose ROLLBACK fails is discarded, not returned to the pool.
 */
import type { Pool } from "pg";
import type { Sql } from "./store.ts";

export type Run = <T>(text: string, params: unknown[]) => Promise<T[]>;
export type Begin = <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;

/** Wrap a query runner in the tagged-template + `.query()` `Sql` surface. */
export function toSql(run: Run, begin: Begin): Sql {
  const sql = (async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    // Rebuild with $1, $2, … placeholders so values stay parameterized.
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return run<T>(text, values);
  }) as unknown as Sql;
  sql.query = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    run<T>(text, params);
  sql.begin = begin;
  return sql;
}

/** A transaction handle. Nested `begin` calls run inside this same transaction. */
export function transactionSql(run: Run): Sql {
  const tx: Sql = toSql(run, (fn) => fn(tx));
  return tx;
}

/**
 * A `Sql` over a node-postgres pool. `begin` pins one client for the whole block: BEGIN, the block, then COMMIT, or
 * ROLLBACK when the block throws. If the ROLLBACK itself fails, that connection is discarded instead of being reused.
 */
export function createPoolSql(pool: Pool): Sql {
  const begin: Begin = async (fn) => {
    const client = await pool.connect();
    let discard: Error | undefined;
    try {
      await client.query("BEGIN");
      const result = await fn(
        transactionSql(async <T>(text: string, params: unknown[]) => (await client.query(text, params)).rows as T[]),
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw error;
    } finally {
      client.release(discard);
    }
  };
  return toSql(async <T>(text: string, params: unknown[]) => (await pool.query(text, params)).rows as T[], begin);
}
