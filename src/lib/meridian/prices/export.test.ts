import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { prices } from "../../../engine/config/prices.ts";
import { TOKEN_PRICES } from "../factory/price-table.ts";
import { catalogRows, csvLine, engineRows, factoryTokenRows, renderPriceFiles, type CatalogSnapshot } from "./export.ts";

const CATALOG_URL = new URL("../../../engine/orchestrator/fixtures/openrouter-catalog-2026-10-20.json", import.meta.url);
const OUT_DIR = new URL("../../../../docs/data/prices/", import.meta.url);

const catalog = JSON.parse(readFileSync(CATALOG_URL, "utf8")) as CatalogSnapshot;

describe("the price files", () => {
  it("match the data, so a change to a price shows up as a change to its file", () => {
    const files = renderPriceFiles({ catalog });
    for (const [name, expected] of Object.entries(files)) {
      const committed = readFileSync(new URL(name, OUT_DIR), "utf8");
      assert.equal(committed, expected, `${name} has drifted from the data. Run: npm run prices:export`);
    }
  });
});

describe("the engine price rows", () => {
  it("write an unknown price as the word unknown, never as 0", () => {
    const rows = engineRows(prices.entries);
    const hyperframes = rows.find((row) => row[0] === "render_hyperframes_cloud");
    assert.deepEqual(hyperframes, ["render_hyperframes_cloud", "per_minute", "unknown", "list_oct_2026"]);
    const pexels = rows.find((row) => row[0] === "pexels");
    assert.deepEqual(pexels, ["pexels", "per_call", "0", "list_oct_2026"]);
  });

  it("has one row per key, under one header", () => {
    const rows = engineRows(prices.entries);
    assert.equal(rows.length, Object.keys(prices.entries).length + 1);
    assert.deepEqual(rows[0], ["key", "unit", "usd", "source"]);
  });
});

describe("the Factory token rows", () => {
  it("write a short-context and a long-context row for each model", () => {
    const rows = factoryTokenRows(TOKEN_PRICES);
    assert.equal(rows.length, 1 + TOKEN_PRICES.length * 2);
    assert.equal(rows[1]?.[2], "short_context");
    assert.equal(rows[2]?.[2], "long_context");
  });
});

describe("the OpenRouter listing rows", () => {
  it("keep every listed model, with its prompt price per million tokens", () => {
    const rows = catalogRows(catalog);
    assert.equal(rows.length, 1 + catalog.entries.length);
    const fable = rows.find((row) => row[0] === "~anthropic/claude-fable-latest");
    assert.equal(fable?.[3], "10", "0.00001 dollars a token is 10 dollars a million tokens");
    assert.equal(fable?.[4], "50");
  });

  it("keeps a name with a comma in one row, because the line writer quotes it", () => {
    assert.equal(csvLine(["a,b", "c"]), '"a,b",c');
    assert.equal(csvLine(['say "hi"', "d"]), '"say ""hi""",d');

    const sample: CatalogSnapshot = {
      source: "test",
      takenAt: "2026-01-01",
      entries: [
        {
          id: "x/y",
          name: "Model, with a comma",
          kind: "text",
          pricing: { promptUsdPerToken: null, completionUsdPerToken: null, imageUsd: null, usdPerSecond1080p: null },
        },
      ],
    };
    const rows = catalogRows(sample);
    assert.equal(rows[1]?.[1], "Model, with a comma");
    assert.deepEqual(rows[1]?.slice(3), ["unknown", "unknown", "unknown", "unknown"]);
  });
});
