// Writes the price data Meridian holds into docs/data/prices/, so the prices can be read offline and fed to research.
// Run it from the repository root after a price changes: npm run prices:export. The test in src/lib/meridian/prices fails
// when the committed files drift from the data.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderPriceFiles, type CatalogSnapshot } from "../src/lib/meridian/prices/export.ts";

const root = process.cwd();
const catalogPath = join(root, "src/engine/orchestrator/fixtures/openrouter-catalog-2026-10-20.json");
const outDir = join(root, "docs/data/prices");

const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as CatalogSnapshot;
const files = renderPriceFiles({ catalog });

mkdirSync(outDir, { recursive: true });
for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(outDir, name), content);
  console.log(`wrote docs/data/prices/${name}`);
}
