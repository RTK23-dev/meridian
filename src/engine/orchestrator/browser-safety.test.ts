import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The canvas and its editor run in the browser, so the modules they import must not pull in Node-only code (node:crypto through
// contracts/hash.ts, node:fs, and so on). This test reads each module's imports and fails if one of them is Node-only.
const BROWSER_MODULES = ["contracts.ts", "catalog.ts", "validate.ts", "stale.ts", "layout.ts", "replay.ts", "fixtures/catalog-snapshot.ts"];

test("the modules the browser loads import no Node-only module", () => {
  for (const name of BROWSER_MODULES) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import[^"\n]*from "([^"]+)"/gm)].map((match) => match[1] ?? "");
    for (const specifier of imports) {
      assert.equal(specifier.startsWith("node:"), false, `${name} imports ${specifier}`);
      assert.equal(specifier.includes("contracts/hash"), false, `${name} imports the hashing module ${specifier}`);
    }
  }
});

test("the catalog module is the recorded snapshot", async () => {
  const { catalogSnapshotRaw } = await import("./fixtures/catalog-snapshot.ts");
  const recorded = JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"));
  assert.deepEqual(catalogSnapshotRaw, recorded);
});
