import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Owner direction (2026-10-20): no fixed models. The orchestrator's source names no model. Every model it uses comes from the live
// catalog at run time. This test reads the orchestrator's own source files (not the tests, not the recorded fixtures) and fails if
// any quoted string looks like a vendor/model id.
const MODEL_ID_IN_QUOTES = /"~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*"/i;

test("no orchestrator source file names a model id", () => {
  const dir = new URL(".", import.meta.url);
  const sources = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  assert.ok(sources.length > 0);
  const hits: string[] = [];
  for (const name of sources) {
    readFileSync(new URL(name, dir), "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (MODEL_ID_IN_QUOTES.test(line)) hits.push(`${name}:${index + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(hits, []);
});
