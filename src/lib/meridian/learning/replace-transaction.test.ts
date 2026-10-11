import assert from "node:assert/strict";
import test from "node:test";
import { applyLearnedPatterns, type Sql } from "./store.ts";

// A fake database with real transaction semantics: statements inside `begin` are staged and applied only when the block
// returns; a throw discards them. That is what the replacement relies on, so the rollback is checked against it.

type Staged = { op: "delete" } | { op: "insert"; id: string };

function fakeDatabase(options: { failInsertAt?: number } = {}) {
  let committed: string[] = ["old-pattern"];
  let inserts = 0;

  const creativeRows = Array.from({ length: 16 }, (_, index) => ({
    id: `creative-${index}`,
    organization_id: "org-learning",
    brand_id: "brand-learning",
    origin: "own",
    angle: index < 8 ? "curiosity" : "offer",
    hook_type: "",
    format: "ugc",
    proof_type: "",
    offer: "",
    cta: "shop",
    visual_style: "",
    platform: "meta",
    emotion: "",
    product_name: "Soap",
    claim: "",
    raw_text: "text",
  }));
  const observationRows = creativeRows.map((row) => ({
    creative_id: row.id,
    organization_id: "org-learning",
    brand_id: "brand-learning",
    impressions: 4000,
    clicks: row.angle === "curiosity" ? 480 : 160,
    conversions: row.angle === "curiosity" ? 40 : 12,
    spend_cents: 4000,
    revenue_cents: row.angle === "curiosity" ? 12000 : 4000,
  }));

  function runStatement(text: string, staged: Staged[] | null): unknown[] {
    if (text.includes("from creative_records")) return creativeRows;
    if (text.includes("from performance_observations")) return observationRows;
    if (text.includes("from organic_observations")) return [];
    if (text.includes("pg_advisory_xact_lock")) return [];
    if (text.includes("delete from learned_patterns")) {
      if (!staged) throw new Error("a write outside a transaction");
      staged.push({ op: "delete" });
      return [];
    }
    if (text.includes("insert into learned_patterns")) {
      if (!staged) throw new Error("a write outside a transaction");
      inserts += 1;
      if (options.failInsertAt === inserts) throw new Error("disk full");
      staged.push({ op: "insert", id: `new-${inserts}` });
      return [];
    }
    throw new Error(`unexpected statement: ${text}`);
  }

  function makeSql(staged: Staged[] | null, transactional: boolean): Sql {
    const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
      let text = strings[0];
      for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
      return Promise.resolve(runStatement(text, staged) as never[]);
    };
    const begin = async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> => {
      const block: Staged[] = [];
      const result = await fn(makeSql(block, true));
      // Only reached when the block returned: apply the staged writes in order.
      for (const write of block) {
        if (write.op === "delete") committed = [];
        else committed = [...committed, write.id];
      }
      return result;
    };
    const sql = Object.assign(run, { query: (text: string) => Promise.resolve(runStatement(text, staged) as never[]) });
    return (transactional ? Object.assign(sql, { begin }) : sql) as unknown as Sql;
  }

  return {
    sql: makeSql(null, true),
    /** The same database, reached through a connection that cannot open a transaction. */
    withoutTransactions: makeSql(null, false),
    get committed() {
      return committed;
    },
  };
}

test("a failed insert rolls the replacement back: the brand keeps its previous patterns", async () => {
  const database = fakeDatabase({ failInsertAt: 2 });
  await assert.rejects(applyLearnedPatterns(database.sql, "org-learning", "brand-learning"), /disk full/);
  assert.deepEqual(database.committed, ["old-pattern"], "the delete was not committed, so no empty or partial set is visible");
});

test("a successful replacement swaps the old set for the new one in a single commit", async () => {
  const database = fakeDatabase();
  const count = await applyLearnedPatterns(database.sql, "org-learning", "brand-learning");
  assert.ok(count > 0, "the fixture produces at least one learned pattern");
  assert.ok(!database.committed.includes("old-pattern"), "the previous patterns are gone after the commit");
  assert.equal(database.committed.length, count);
});

test("the replacement refuses to run without a transaction, before any write", async () => {
  const database = fakeDatabase();
  await assert.rejects(
    applyLearnedPatterns(database.withoutTransactions, "org-learning", "brand-learning"),
    /cannot run a transaction/,
  );
  assert.deepEqual(database.committed, ["old-pattern"]);
});
